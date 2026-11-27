package ua.reis.nav

import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import org.json.JSONArray
import org.json.JSONObject

/**
 * Розпізнавання мови з вибором мікрофона (оболонка №10, «Рейс» 1.1.38).
 *
 * Без гарнітури — як було: розпізнавач Google сам слухає мікрофон телефона.
 * З дротовою гарнітурою (Type-C, міні-джек) на Android 13+ мікрофон слухає сама програма (MicFeed) і віддає звук
 * розпізнавачу трубою. Шляхи пробуємо по черзі, доки якийсь не спрацює:
 *   1) звичайний розпізнавач Google + наш звук;
 *   2) розпізнавач у самому телефоні (без інтернету) + наш звук;
 *   3) як було: розпізнавач слухає сам.
 * Що з'ясували про розпізнавачі телефона, пам'ятаємо до перезапуску програми — наступного разу без зайвих спроб.
 *
 * Події для інтерфейсу (тип "stt"): ready · partial · final · error — як раніше; нові: level {v}, mic {kind,name,how,why}, hint {code}.
 */
class Stt(private val ctx: Context, private val emit: (String, JSONObject) -> Unit) {

    private enum class Way { DEFAULT_FEED, ONDEVICE_FEED, PLAIN }
    private class Route(val dev: AudioDeviceInfo, val spare: AudioDeviceInfo?, val gain: Boolean, val why: String)

    private val main = Handler(Looper.getMainLooper())
    /** "auto" — гарнітура, а якщо вона «німа» — телефон; "headset" — лише гарнітура; "phone" — мікрофон телефона, навіть із гарнітурою. */
    @Volatile var mode = "auto"
    @Volatile private var seq = 0
    private var sr: SpeechRecognizer? = null
    private var feed: MicFeed? = null
    private var route: Route? = null
    private var way = Way.PLAIN
    private val ways = ArrayDeque<Way>()
    private var lang = "uk-UA"
    private var heard = false              // уже були слова — спосіб не міняємо
    private var stopping = false           // водій сам зупинив — нових спроб не робимо
    private var ended = false              // розпізнавач сказав «кінець мови» — далі він лише дораховує, звук уже не бере
    private var lastErr = "err"
    @Volatile private var lastLvl = 0L
    private var defaultTakesFeed: Boolean? = null       // null — ще не знаємо; false — Google наш звук не бере, слухає сам
    private val onDeviceNo = HashSet<String>()           // мови, яких розпізнавач у телефоні не має

    private fun onDeviceAvailable() = Build.VERSION.SDK_INT >= 33 && try { SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx) } catch (_: Exception) { false }

    private fun pickRoute(): Route? {
        if (Build.VERSION.SDK_INT < 33) return null                 // звук розпізнавачу можна передати лише з Android 13
        val hs = Mics.headset(ctx) ?: return null                   // гарнітури немає — нічого не міняємо
        val ph = Mics.builtin(ctx)
        return when (mode) {
            "phone" -> ph?.let { Route(it, null, false, "mode") }
            "headset" -> Route(hs, null, true, "")
            else -> Route(hs, ph, true, "")
        }
    }

    fun info(): JSONObject {
        val ins = JSONArray()
        for (d in Mics.inputs(ctx)) ins.put(Mics.json(d))
        return JSONObject().put("sdk", Build.VERSION.SDK_INT).put("feed", Build.VERSION.SDK_INT >= 33)
            .put("onDevice", onDeviceAvailable()).put("mode", mode).put("inputs", ins)
            .put("defaultFeed", defaultTakesFeed?.toString() ?: "?")
    }

    /* ---------- події ---------- */
    private fun ev(state: String) = JSONObject().put("state", state)
    private fun sttError(code: String) = emit("stt", ev("error").put("code", code))
    private fun hint(code: String) = emit("stt", ev("hint").put("code", code))
    private fun mic(d: AudioDeviceInfo?, how: String, why: String) =
        emit("stt", ev("mic").put("kind", Mics.kind(d)).put("name", d?.let { Mics.json(it).optString("name") } ?: "").put("how", how).put("why", why))
    private fun level(my: Int, v: Float) {
        if (my != seq) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastLvl < 70) return
        lastLvl = now
        emit("stt", ev("level").put("v", Math.round(v * 100) / 100.0))
    }

    /* ---------- керування ---------- */
    fun start(lang: String) {
        reset()
        this.lang = lang
        heard = false
        stopping = false
        lastErr = "err"
        ways.clear()
        route = pickRoute()
        if (route != null) {
            if (defaultTakesFeed != false) ways.add(Way.DEFAULT_FEED)
            if (onDeviceAvailable() && lang !in onDeviceNo) ways.add(Way.ONDEVICE_FEED)
        } else if (Build.VERSION.SDK_INT < 33 && Mics.headset(ctx) != null) hint("sdk")
        ways.add(Way.PLAIN)
        next()
    }

    /** Водій сам зупинив запис: розпізнавач дораховує сказане, труба закривається. */
    fun stop() {
        stopping = true
        ways.clear()
        try { sr?.stopListening() } catch (_: Exception) {}
        stopFeed()
    }

    fun destroy() { reset() }

    private fun reset() {
        seq++
        stopFeed()
        val r = sr
        sr = null
        if (r != null) { try { r.cancel() } catch (_: Exception) {}; try { r.destroy() } catch (_: Exception) {} }
    }

    private fun stopFeed() { feed?.stop(); feed = null }

    private fun next() {
        val w = ways.removeFirstOrNull() ?: run { sttError(lastErr); return }
        // старий розпізнавач і запис прибираємо; події від них далі не слухаємо
        reset()
        val my = seq
        way = w
        ended = false
        var src: ParcelFileDescriptor? = null
        val rt = route
        if (w != Way.PLAIN && rt != null) {
            val f = MicFeed(ctx, rt.dev, rt.spare, rt.gain,
                onLevel = { v -> level(my, v) },
                onSwitch = { d -> main.post { if (my == seq) mic(d, "own", "silent") } },
                onStall = { main.post { if (my == seq) ignored(my) } })
            src = f.start()
            if (src == null) {                                          // мікрофон не відкрився — лишаємо як було
                ways.removeAll { it != Way.PLAIN }
                next(); return
            }
            feed = f
            mic(rt.dev, "own", rt.why)
        }
        val rec = try {
            if (w == Way.ONDEVICE_FEED && Build.VERSION.SDK_INT >= 31) SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
            else SpeechRecognizer.createSpeechRecognizer(ctx)
        } catch (e: Exception) {
            lastErr = e.javaClass.simpleName
            if (w == Way.ONDEVICE_FEED) onDeviceNo.add(lang)
            next(); return
        }
        sr = rec
        rec.setRecognitionListener(listener(my))
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        if (src != null && Build.VERSION.SDK_INT >= 33) {
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, src)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, MicFeed.RATE)
        }
        try { rec.startListening(i) } catch (e: Exception) { lastErr = e.javaClass.simpleName; next() }
    }

    /** Через мить після «готовий слухати»: хто насправді пише звук. */
    private fun probe(my: Int) {
        if (my != seq) return
        val f = feed
        val others = Mics.others(ctx, f?.session ?: Int.MIN_VALUE)
        if (f != null) {
            if (others.isNotEmpty()) ignored(my)                       // розпізнавач відкрив мікрофон сам, наш звук йому не потрібен
        } else {
            // розпізнавач слухає сам — показуємо, який мікрофон дав йому телефон (з гарнітурою це видно одразу)
            mic(others.firstOrNull()?.audioDevice, "system", "")
        }
    }

    /** Розпізнавач не бере наш звук. Пробуємо інший розпізнавач або віддаємо мікрофон йому (як до 1.1.38). */
    private fun ignored(my: Int) {
        if (my != seq || feed == null || stopping || ended) return
        if (way == Way.DEFAULT_FEED) defaultTakesFeed = false
        if (heard) { stopFeed(); return }                               // слова вже йдуть — працює і так
        if (ways.any { it != Way.PLAIN }) { next(); return }
        stopFeed()
        ways.clear()
        way = Way.PLAIN
        hint("nofeed")
        main.postDelayed({ probe(my) }, 500)
    }

    private val retryable = setOf(
        SpeechRecognizer.ERROR_AUDIO, SpeechRecognizer.ERROR_CLIENT, SpeechRecognizer.ERROR_SERVER, 11 /* SERVER_DISCONNECTED */,
        12 /* LANGUAGE_NOT_SUPPORTED */, 13 /* LANGUAGE_UNAVAILABLE */, 14 /* CANNOT_CHECK_SUPPORT */,
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT        // без інтернету — розпізнавач у телефоні
    )

    private fun codeOf(error: Int) = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH -> "nomatch"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "timeout"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "denied"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
        else -> "err$error"
    }

    private fun listener(my: Int) = object : RecognitionListener {
        private fun live() = my == seq
        override fun onReadyForSpeech(params: Bundle?) {
            if (!live()) return
            emit("stt", ev("ready"))
            main.postDelayed({ probe(my) }, 600)
        }
        override fun onBeginningOfSpeech() { if (live()) heard = true }        // розпізнавач чує мову — спосіб більше не міняємо
        override fun onRmsChanged(rmsdB: Float) {
            // рівень показуємо зі свого запису; коли слухає сам розпізнавач — з його оцінки (≈ −2…10 дБ)
            if (live() && feed == null) level(my, ((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
        }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() { if (live()) ended = true }
        override fun onEvent(eventType: Int, params: Bundle?) {}
        override fun onPartialResults(partialResults: Bundle?) {
            if (!live()) return
            val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
            if (t.isNotBlank()) {
                heard = true
                if (way == Way.DEFAULT_FEED && feed != null) defaultTakesFeed = true
            }
            emit("stt", ev("partial").put("text", t))
        }
        override fun onResults(results: Bundle?) {
            if (!live()) return
            val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            if (t.isNotBlank() && way == Way.DEFAULT_FEED && feed != null) defaultTakesFeed = true
            stopFeed()
            emit("stt", ev("final").put("text", t))
        }
        override fun onError(error: Int) {
            if (!live()) return
            val code = codeOf(error)
            // збій ще до першого слова — пробуємо наступний шлях (інший розпізнавач чи без власного запису)
            if (!heard && !stopping && way != Way.PLAIN && error in retryable) {
                if (way == Way.ONDEVICE_FEED && (error == 12 || error == 13)) {
                    onDeviceNo.add(lang)
                    if (error == 13) hint("langdl")                   // мова є, але не завантажена в телефон
                }
                lastErr = code
                next()
                return
            }
            stopFeed()
            sttError(code)
        }
    }

    /** Завантажити мову для розпізнавання в самому телефоні (Android 13+; система може спитати згоду). */
    fun langDownload(lang: String): Boolean {
        if (!onDeviceAvailable() || Build.VERSION.SDK_INT < 33) return false
        return try {
            val r = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
            r.triggerModelDownload(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang))
            onDeviceNo.remove(lang)
            main.postDelayed({ try { r.destroy() } catch (_: Exception) {} }, 20000)
            true
        } catch (_: Exception) { false }
    }
}

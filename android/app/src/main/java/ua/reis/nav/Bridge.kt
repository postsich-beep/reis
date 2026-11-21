package ua.reis.nav

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.WindowManager
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Місток між інтерфейсом (JavaScript) і телефоном. У JS це об'єкт window.ReisNative.
 * Відповіді й події йдуть назад через MainActivity.emit → window.__reis(type, data).
 */
class Bridge(private val act: MainActivity) {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(4)

    // Запити через місток дозволені лише до цих сайтів (вони не віддають дані сторінкам напряму).
    private val httpHosts = setOf("t.me", "api.alerts.in.ua", "alerts.in.ua", "api.anthropic.com")

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsFailed = false
    private var ttsQueued: (() -> Unit)? = null
    private var ttsLang = ""
    private var sr: SpeechRecognizer? = null
    private var notifId = 100
    private var update: JSONObject? = null

    private fun emit(type: String, o: JSONObject) = act.emit(type, o.toString())

    /* ---------- загальне ---------- */
    @JavascriptInterface
    fun info(): String = JSONObject()
        .put("native", true).put("app", BuildConfig.VERSION_NAME).put("code", BuildConfig.VERSION_CODE)
        .put("web", WebStore.activeVersion).put("bundledWeb", WebStore.bundledVersion)
        .put("sdk", Build.VERSION.SDK_INT).put("model", Build.MANUFACTURER + " " + Build.MODEL)
        .put("repo", BuildConfig.UPDATE_REPO).toString()

    @JavascriptInterface
    fun ready() { act.onJsReady() }

    @JavascriptInterface
    fun startTracking() { main.post { act.startTracking() } }

    @JavascriptInterface
    fun stopTracking() { main.post { act.stopTracking() } }

    @JavascriptInterface
    fun keepAwake(on: Boolean) {
        main.post {
            if (on) act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    @JavascriptInterface
    fun openUrl(url: String) {
        if (!url.startsWith("https://")) return
        main.post { try { act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {} }
    }

    /** Системні налаштування геолокації (кнопка «Увімкнути геолокацію»). */
    @JavascriptInterface
    fun openLocationSettings() {
        main.post { try { act.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) } catch (_: Exception) {} }
    }

    /** Сторінка застосунку в налаштуваннях: дозволи, батарея, автозапуск. */
    @JavascriptInterface
    fun openAppSettings() {
        main.post {
            try { act.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + act.packageName))) } catch (_: Exception) {}
        }
    }

    @JavascriptInterface
    fun vibrate(ms: Int) {
        try {
            @Suppress("DEPRECATION")
            val v = act.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            v.vibrate(VibrationEffect.createOneShot(ms.coerceIn(10, 2000).toLong(), VibrationEffect.DEFAULT_AMPLITUDE))
        } catch (_: Exception) {}
    }

    @JavascriptInterface
    fun postNotice(title: String, text: String) {
        try {
            NavService.ensureChannels(act)
            val pi = PendingIntent.getActivity(act, 0, Intent(act, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val n = Notification.Builder(act, NavService.CH_ALERT)
                .setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(pi).setAutoCancel(true).build()
            (act.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(notifId++, n)
        } catch (_: Exception) {}
    }

    /* ---------- синтез мови ---------- */
    private val ttsListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) { emit("tts", JSONObject().put("id", utteranceId ?: "").put("state", "done")) }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) { emit("tts", JSONObject().put("id", utteranceId ?: "").put("state", "error")) }
    }

    private fun withTts(then: () -> Unit) {
        if (ttsReady) { then(); return }
        ttsQueued = then
        if (tts != null || ttsFailed) return
        tts = TextToSpeech(act.applicationContext) { status ->
            main.post {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true
                    tts?.setOnUtteranceProgressListener(ttsListener)
                    val q = ttsQueued
                    ttsQueued = null
                    q?.invoke()
                } else {
                    ttsFailed = true
                    tts = null
                    emit("ttsLang", JSONObject().put("ok", false).put("reason", "engine"))
                }
            }
        }
    }

    @JavascriptInterface
    fun speak(text: String, lang: String, rate: Float, id: String) {
        main.post {
            if (ttsFailed) { emit("tts", JSONObject().put("id", id).put("state", "error")); return@post }
            withTts {
                val t = tts
                if (t == null) { emit("tts", JSONObject().put("id", id).put("state", "error")); return@withTts }
                if (lang != ttsLang) {
                    ttsLang = lang
                    val r = try { t.setLanguage(Locale.forLanguageTag(lang)) } catch (_: Exception) { TextToSpeech.LANG_NOT_SUPPORTED }
                    if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED)
                        emit("ttsLang", JSONObject().put("ok", false).put("lang", lang).put("reason", "voice"))
                }
                t.setSpeechRate(rate.coerceIn(0.5f, 2.0f))
                val res = t.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), id)
                if (res != TextToSpeech.SUCCESS) emit("tts", JSONObject().put("id", id).put("state", "error"))
            }
        }
    }

    @JavascriptInterface
    fun stopSpeak() { main.post { try { tts?.stop() } catch (_: Exception) {} } }

    /* ---------- розпізнавання мови ---------- */
    private fun sttError(code: String) = emit("stt", JSONObject().put("state", "error").put("code", code))

    @JavascriptInterface
    fun listen(lang: String) {
        main.post { act.withMic { startListen(lang) } }
    }

    private fun startListen(lang: String) {
        if (!SpeechRecognizer.isRecognitionAvailable(act)) { sttError("unavailable"); return }
        try {
            sr?.destroy()
            val r = SpeechRecognizer.createSpeechRecognizer(act)
            sr = r
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { emit("stt", JSONObject().put("state", "ready")) }
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
                override fun onPartialResults(partialResults: Bundle?) {
                    val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
                    emit("stt", JSONObject().put("state", "partial").put("text", t))
                }
                override fun onResults(results: Bundle?) {
                    val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                    emit("stt", JSONObject().put("state", "final").put("text", t))
                }
                override fun onError(error: Int) {
                    sttError(when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH -> "nomatch"
                        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "timeout"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "denied"
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
                        else -> "err$error"
                    })
                }
            })
            val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            r.startListening(i)
        } catch (e: Exception) { sttError(e.javaClass.simpleName) }
    }

    @JavascriptInterface
    fun stopListen() { main.post { try { sr?.stopListening() } catch (_: Exception) {} } }

    /* ---------- мережа ---------- */
    private fun readLimited(c: HttpURLConnection, limit: Int): ByteArray {
        val stream = (if (c.responseCode >= 400) c.errorStream else c.inputStream) ?: return ByteArray(0)
        val out = ByteArrayOutputStream()
        stream.use { s ->
            val buf = ByteArray(16384)
            while (true) {
                val n = s.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > limit) throw IOException("response too large")
            }
        }
        return out.toByteArray()
    }

    private fun open(url: String, timeout: Int): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeout.coerceIn(3000, 30000)
        c.readTimeout = timeout.coerceIn(3000, 90000)
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", act.userAgent)
        return c
    }

    @JavascriptInterface
    fun http(id: String, method: String, url: String, headersJson: String, body: String, timeout: Int) {
        io.execute {
            val out = JSONObject().put("id", id)
            var c: HttpURLConnection? = null
            try {
                val u = URL(url)
                if (u.protocol != "https" || !httpHosts.contains(u.host)) throw IOException("host not allowed: " + u.host)
                c = open(url, timeout)
                c.requestMethod = if (method == "POST") "POST" else "GET"
                if (headersJson.isNotEmpty()) {
                    val h = JSONObject(headersJson)
                    val keys = h.keys()
                    while (keys.hasNext()) { val k = keys.next(); c.setRequestProperty(k, h.optString(k)) }
                }
                if (method == "POST") {
                    c.doOutput = true
                    c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val code = c.responseCode
                out.put("status", code).put("body", String(readLimited(c, 4 * 1024 * 1024), Charsets.UTF_8))
            } catch (e: Exception) {
                out.put("error", e.javaClass.simpleName + (e.message?.let { ": $it" } ?: ""))
            } finally {
                try { c?.disconnect() } catch (_: Exception) {}
            }
            emit("http", out)
        }
    }

    /* ---------- файли ---------- */
    @JavascriptInterface
    fun saveFile(name: String, mime: String, text: String) {
        io.execute {
            val o = JSONObject().put("name", name)
            try {
                val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
                if (Build.VERSION.SDK_INT >= 29) {
                    val cv = ContentValues()
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, safe)
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, if (mime.isEmpty()) "application/octet-stream" else mime)
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Reis")
                    val uri = act.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv) ?: throw IOException("no uri")
                    val os = act.contentResolver.openOutputStream(uri) ?: throw IOException("no stream")
                    os.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                    o.put("path", "Download/Reis/$safe")
                } else {
                    val dir = act.getExternalFilesDir(null) ?: act.filesDir
                    val f = File(dir, safe)
                    f.writeText(text, Charsets.UTF_8)
                    o.put("path", f.absolutePath)
                }
            } catch (e: Exception) { o.put("error", e.javaClass.simpleName) }
            emit("saved", o)
        }
    }

    /* ---------- оновлення: версія на сторінці останнього релізу GitHub ---------- */
    private fun releaseUrl(file: String) = "https://github.com/" + BuildConfig.UPDATE_REPO + "/releases/latest/download/" + file

    @JavascriptInterface
    fun checkUpdate() {
        io.execute {
            val o = JSONObject()
            var c: HttpURLConnection? = null
            try {
                if (BuildConfig.UPDATE_REPO.isEmpty()) throw IOException("norepo")
                c = open(releaseUrl("version.json"), 15000)
                if (c.responseCode != 200) throw IOException("HTTP " + c.responseCode)
                val v = JSONObject(String(readLimited(c, 65536), Charsets.UTF_8))
                update = v
                if (v.optInt("apkCode", 0) > BuildConfig.VERSION_CODE)
                    o.put("apk", JSONObject().put("code", v.optInt("apkCode")).put("name", v.optString("apkName")))
                if (v.optInt("web", 0) > WebStore.activeVersion)
                    o.put("web", JSONObject().put("ver", v.optInt("web")))
            } catch (e: Exception) {
                o.put("error", e.message ?: e.javaClass.simpleName)
            } finally {
                try { c?.disconnect() } catch (_: Exception) {}
            }
            emit("update", o)
        }
    }

    @JavascriptInterface
    fun applyWebUpdate() {
        io.execute {
            val o = JSONObject()
            var c: HttpURLConnection? = null
            try {
                if (BuildConfig.UPDATE_REPO.isEmpty()) throw IOException("norepo")
                c = open(releaseUrl("web.zip"), 60000)
                if (c.responseCode != 200) throw IOException("HTTP " + c.responseCode)
                val ver = c.inputStream.use { WebStore.install(act, it) }
                o.put("ok", true).put("ver", ver)
            } catch (e: Exception) {
                o.put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
            } finally {
                try { c?.disconnect() } catch (_: Exception) {}
            }
            emit("webUpdated", o)
        }
    }

    @JavascriptInterface
    fun installApk() {
        if (BuildConfig.UPDATE_REPO.isEmpty()) return
        openUrl(releaseUrl("reis.apk"))        // браузер завантажить файл, Android запропонує встановити поверх
    }

    fun shutdown() {
        try { tts?.stop(); tts?.shutdown() } catch (_: Exception) {}
        try { sr?.destroy() } catch (_: Exception) {}
        io.shutdownNow()
    }
}

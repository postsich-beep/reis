package ua.reis.nav

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.SystemClock
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.ZipInputStream
import kotlin.math.abs
import kotlin.math.min

/**
 * Якісний голос без інтернету: нейромережа Piper (VITS) через sherpa-onnx, прямо в телефоні.
 * Пакет голосу (модель + словник вимови espeak-ng) завантажується з релізу «voices» нашого GitHub
 * у files/voices/<pack>/ і далі працює офлайн. Один пакет може мати кількох дикторів (sid).
 */
class NeuralTts(private val ctx: Context, private val emit: (String, JSONObject) -> Unit) {

    private val exec = Executors.newSingleThreadExecutor()        // синтез і відтворення — по черзі
    private val dlExec = Executors.newSingleThreadExecutor()      // завантаження пакетів
    private val gen = AtomicInteger(0)                            // номер останньої фрази: стара, перервана — мовчить
    @Volatile private var tts: OfflineTts? = null
    @Volatile private var loaded = ""
    @Volatile private var track: AudioTrack? = null
    @Volatile private var dlCancel = false
    @Volatile var dlPack = ""
        private set
    @Volatile var dlPct = -1
        private set
    @Volatile var libOk: Boolean? = null
        private set

    private fun root() = File(ctx.filesDir, "voices")
    fun dir(pack: String) = File(root(), pack.filter { it.isLetterOrDigit() || it == '-' || it == '_' })
    fun installed(pack: String) = File(dir(pack), "voice.json").isFile

    private fun dirSize(f: File): Long = if (f.isDirectory) (f.listFiles() ?: emptyArray()).sumOf { dirSize(it) } else f.length()

    fun status(): JSONObject {
        val packs = JSONObject()
        (root().listFiles() ?: emptyArray()).filter { it.isDirectory && File(it, "voice.json").isFile }.forEach {
            val meta = try { JSONObject(File(it, "voice.json").readText()) } catch (_: Exception) { JSONObject() }
            packs.put(it.name, JSONObject().put("size", dirSize(it)).put("ver", meta.optInt("ver", 0)).put("name", meta.optString("name")))
        }
        val o = JSONObject().put("packs", packs).put("loaded", loaded)
        if (libOk != null) o.put("lib", libOk)
        if (dlPack.isNotEmpty()) o.put("dl", JSONObject().put("pack", dlPack).put("pct", dlPct))
        return o
    }

    /* ---------- модель: завантажуємо в пам'ять один раз, перед першою фразою ---------- */
    private fun ensure(pack: String): OfflineTts {
        val cur = tts
        if (cur != null && loaded == pack) return cur
        release()
        val d = dir(pack)
        val meta = JSONObject(File(d, "voice.json").readText())
        val model = File(d, meta.getString("model"))
        if (!model.isFile) throw IOException("model missing")
        val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)
        val vits = OfflineTtsVitsModelConfig(
            model = model.path,
            tokens = File(d, meta.optString("tokens", "tokens.txt")).path,
            dataDir = File(d, meta.optString("data", "espeak-ng-data")).path,
            noiseScale = meta.optDouble("noise", 0.667).toFloat(),
            noiseScaleW = meta.optDouble("noiseW", 0.8).toFloat(),
            lengthScale = 1.0f,
        )
        val cfg = OfflineTtsConfig(model = OfflineTtsModelConfig(vits = vits, numThreads = threads, debug = false, provider = "cpu"), maxNumSentences = 2)
        val t0 = SystemClock.elapsedRealtime()
        val t = try { OfflineTts(null, cfg).also { libOk = true } } catch (e: Throwable) {
            if (e is UnsatisfiedLinkError || e is ExceptionInInitializerError || e is NoClassDefFoundError) libOk = false
            throw IOException("engine: " + (e.message ?: e.javaClass.simpleName))
        }
        tts = t; loaded = pack
        emit("voice", JSONObject().put("state", "loaded").put("pack", pack).put("ms", SystemClock.elapsedRealtime() - t0))
        return t
    }

    fun preload(pack: String) { if (installed(pack)) exec.execute { try { ensure(pack) } catch (e: Exception) { emit("voice", JSONObject().put("state", "error").put("pack", pack).put("error", e.message ?: "")) } } }

    fun release() {
        val t = tts; tts = null; loaded = ""
        try { t?.release() } catch (_: Throwable) {}
    }

    fun unload() { stop(); exec.execute { release() } }

    /* ---------- фраза: синтез → гучність → відтворення з приглушенням музики ---------- */
    fun speak(pack: String, sid: Int, text: String, rate: Float, id: String, onFail: (String) -> Unit) {
        val my = gen.incrementAndGet()
        stopTrack()
        exec.execute {
            if (my != gen.get()) { emit("tts", JSONObject().put("id", id).put("state", "done")); return@execute }
            try {
                val t = ensure(pack)
                val sp = rate.coerceIn(0.6f, 1.7f)
                val a = t.generate(text, sid.coerceIn(0, maxOf(0, t.numSpeakers() - 1)), sp)
                if (my != gen.get()) { emit("tts", JSONObject().put("id", id).put("state", "done")); return@execute }
                play(a.samples, a.sampleRate, my)
                emit("tts", JSONObject().put("id", id).put("state", "done"))
            } catch (e: Throwable) {
                if (my == gen.get()) onFail(e.message ?: e.javaClass.simpleName)
                else emit("tts", JSONObject().put("id", id).put("state", "done"))
            }
        }
    }

    fun stop() { gen.incrementAndGet(); stopTrack() }

    private fun stopTrack() {
        val tr = track ?: return
        try { tr.pause(); tr.flush() } catch (_: Exception) {}
    }

    private fun play(raw: FloatArray, sr: Int, my: Int) {
        if (raw.isEmpty()) return
        // рівна гучність: пік ~0,9 (тихі фрази підсилюємо не більше ніж утричі), 60 мс тиші на початку — щоб Bluetooth не «з'їв» перший склад
        var peak = 0f
        for (v in raw) { val x = abs(v); if (x > peak) peak = x }
        val gain = if (peak > 0.01f) min(3f, 0.9f / peak) else 1f
        val lead = sr * 60 / 1000
        val s = FloatArray(raw.size + lead)
        for (i in raw.indices) s[lead + i] = (raw[i] * gain).coerceIn(-1f, 1f)

        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build()
        try { am.requestAudioFocus(focus) } catch (_: Exception) {}
        val fmt = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(sr).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
        val minBuf = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val tr = AudioTrack.Builder().setAudioAttributes(attrs).setAudioFormat(fmt)
            .setBufferSizeInBytes(maxOf(minBuf, sr * 4 / 4)).setTransferMode(AudioTrack.MODE_STREAM).build()
        track = tr
        try {
            tr.play()
            var off = 0
            val chunk = sr / 10
            while (off < s.size && my == gen.get()) {
                val n = tr.write(s, off, min(chunk, s.size - off), AudioTrack.WRITE_BLOCKING)
                if (n <= 0) break
                off += n
            }
            if (my == gen.get()) {
                // дограти записане до кінця
                val total = off
                val until = SystemClock.elapsedRealtime() + (total * 1000L / sr) + 1500
                while (my == gen.get() && tr.playbackHeadPosition < total && SystemClock.elapsedRealtime() < until) Thread.sleep(30)
            }
        } finally {
            try { tr.stop() } catch (_: Exception) {}
            try { tr.release() } catch (_: Exception) {}
            if (track === tr) track = null
            try { am.abandonAudioFocusRequest(focus) } catch (_: Exception) {}
        }
    }

    /* ---------- пакети голосів: завантажити, розпакувати, видалити ---------- */
    fun download(pack: String, url: String, open: (String) -> HttpURLConnection) {
        if (dlPack.isNotEmpty()) return
        dlPack = pack; dlPct = 0; dlCancel = false
        dlExec.execute {
            val d = dir(pack)
            val tmpZip = File(root().apply { mkdirs() }, "$pack.zip.part")
            val tmpDir = File(root(), "$pack.new")
            var c: HttpURLConnection? = null
            try {
                c = open(url)
                if (c.responseCode != 200) throw IOException("HTTP " + c.responseCode)
                val total = c.contentLengthLong
                if (total > 0 && ctx.filesDir.usableSpace < total * 3 + 50_000_000L) throw IOException("space")
                var got = 0L
                var last = -1
                c.inputStream.use { inp ->
                    tmpZip.outputStream().use { out ->
                        val buf = ByteArray(1 shl 16)
                        while (true) {
                            if (dlCancel) throw IOException("cancel")
                            val n = inp.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n); got += n
                            val pct = if (total > 0) (got * 90 / total).toInt() else -1
                            if (pct != last && (pct - last >= 2 || pct < 0)) { last = pct; dlPct = pct; emit("voice", JSONObject().put("state", "dl").put("pack", pack).put("pct", pct).put("got", got).put("total", total)) }
                        }
                    }
                }
                emit("voice", JSONObject().put("state", "unzip").put("pack", pack).put("pct", 92))
                tmpDir.deleteRecursively(); tmpDir.mkdirs()
                tmpZip.inputStream().use { unzip(it, tmpDir) }
                if (!File(tmpDir, "voice.json").isFile) throw IOException("bad pack")
                if (loaded == pack) { stop(); exec.submit(Runnable { release() }).get() }
                d.deleteRecursively()
                if (!tmpDir.renameTo(d)) throw IOException("rename")
                emit("voice", JSONObject().put("state", "ready").put("pack", pack).put("size", dirSize(d)))
            } catch (e: Exception) {
                tmpDir.deleteRecursively()
                emit("voice", JSONObject().put("state", if (dlCancel) "cancel" else "error").put("pack", pack).put("error", e.message ?: e.javaClass.simpleName))
            } finally {
                try { c?.disconnect() } catch (_: Exception) {}
                tmpZip.delete()
                dlPack = ""; dlPct = -1
            }
        }
    }

    fun cancelDownload() { dlCancel = true }

    fun delete(pack: String) {
        exec.execute {
            if (loaded == pack) release()
            dir(pack).deleteRecursively()
            emit("voice", JSONObject().put("state", "deleted").put("pack", pack))
        }
    }

    private fun unzip(input: InputStream, dst: File) {
        val base = dst.canonicalPath + File.separator
        ZipInputStream(input.buffered()).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                val f = File(dst, e.name)
                if (!f.canonicalPath.startsWith(base)) throw IOException("bad entry")     // без виходу за межі теки
                if (e.isDirectory) f.mkdirs()
                else { f.parentFile?.mkdirs(); f.outputStream().use { z.copyTo(it, 1 shl 16) } }
                z.closeEntry()
            }
        }
    }
}

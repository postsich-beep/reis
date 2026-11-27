package ua.reis.nav

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import org.json.JSONObject
import java.io.IOException
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

/** Мікрофони телефона: що підключено, який узяти, як назвати для інтерфейсу. */
object Mics {
    private const val TYPE_BLE_HEADSET = 26                     // AudioDeviceInfo.TYPE_BLE_HEADSET (Android 12)
    private const val SOURCE_HOTWORD = 1999                     // MediaRecorder.AudioSource.HOTWORD — «Окей, Google», не рахуємо

    private fun am(ctx: Context) = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    fun inputs(ctx: Context): List<AudioDeviceInfo> =
        try { am(ctx).getDevices(AudioManager.GET_DEVICES_INPUTS).toList() } catch (_: Exception) { emptyList() }

    /** Дротова гарнітура: Type-C (цифрова), Type-C через перехідник, міні-джек. */
    fun headset(ctx: Context): AudioDeviceInfo? = inputs(ctx).firstOrNull {
        it.type == AudioDeviceInfo.TYPE_USB_HEADSET || it.type == AudioDeviceInfo.TYPE_USB_DEVICE || it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET
    }

    fun builtin(ctx: Context): AudioDeviceInfo? = inputs(ctx).firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }

    fun kind(d: AudioDeviceInfo?): String = when (d?.type) {
        null -> ""
        AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "usb"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "phone"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, TYPE_BLE_HEADSET -> "bt"
        AudioDeviceInfo.TYPE_TELEPHONY -> "tel"
        else -> "other"
    }

    fun json(d: AudioDeviceInfo): JSONObject = JSONObject().put("kind", kind(d)).put("type", d.type)
        .put("name", if (d.type == AudioDeviceInfo.TYPE_BUILTIN_MIC) "" else (d.productName?.toString() ?: ""))

    /** Чужі записи, що йдуть просто зараз (розпізнавач Google пише сам), без нашого власного (own — його номер сесії). */
    fun others(ctx: Context, own: Int) = try {
        am(ctx).activeRecordingConfigurations.filter { it.clientAudioSessionId != own && it.clientAudioSource != SOURCE_HOTWORD }
    } catch (_: Exception) { emptyList() }
}

/**
 * Власний запис із вибраного мікрофона → труба → розпізнавач (RecognizerIntent.EXTRA_AUDIO_SOURCE, Android 13+).
 * Навіщо: розпізнавач Google слухає той мікрофон, який дасть йому телефон, а з гарнітурою Type-C це мікрофон гарнітури —
 * часто дуже тихий (режим розпізнавання без автопідсилення) або взагалі «німий» (перехідник каже, що мікрофон є, а його немає).
 * Тут ми самі вибираємо мікрофон, підсилюємо тихий звук до рівня, який розпізнавач чує, а «німу» гарнітуру за 1,2 с
 * міняємо на мікрофон телефона.
 */
class MicFeed(
    private val ctx: Context,
    dev: AudioDeviceInfo?,
    private val spare: AudioDeviceInfo?,          // на кого перейти, якщо dev мовчить (null — не переходити)
    private val gainOn: Boolean,
    private val onLevel: (Float) -> Unit,         // рівень 0…1 для смужки в інтерфейсі, ~12 разів на секунду
    private val onSwitch: (AudioDeviceInfo) -> Unit,
    private val onStall: () -> Unit                // розпізнавач не забирає звук із труби — значить, слухає мікрофон сам
) {
    companion object { const val RATE = 16000 }

    @Volatile private var running = false
    @Volatile var device: AudioDeviceInfo? = dev
        private set
    private var th: Thread? = null
    private var rd: ParcelFileDescriptor? = null
    var session = -1
        private set

    /** Повертає кінець труби для розпізнавача або null, якщо мікрофон не відкрився. */
    fun start(): ParcelFileDescriptor? {
        val (r, inRate) = open() ?: return null
        val pipe = try { ParcelFileDescriptor.createPipe() } catch (_: IOException) { r.release(); return null }
        rd = pipe[0]
        session = r.audioSessionId
        running = true
        th = Thread({ loop(r, inRate, pipe[1]) }, "reis-mic").also { it.isDaemon = true; it.start() }
        return pipe[0]
    }

    fun stop() {
        running = false
        try { th?.join(300) } catch (_: InterruptedException) {}
        th = null
        try { rd?.close() } catch (_: Exception) {}
        rd = null
    }

    @SuppressLint("MissingPermission")             // дозвіл на мікрофон перевіряє MainActivity.withMic до запуску
    private fun open(): Pair<AudioRecord, Int>? {
        // 16 кГц моно — те, що чекає розпізнавач. Деякі телефони гарнітуру Type-C на 16 кГц не відкривають — тоді 48 кГц і проріджуємо втричі.
        for (rate in intArrayOf(RATE, 48000)) {
            val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (min <= 0) continue
            val r = try {
                AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min * 2, rate))
            } catch (_: Exception) { null } ?: continue
            if (r.state != AudioRecord.STATE_INITIALIZED) { r.release(); continue }
            device?.let { try { r.setPreferredDevice(it) } catch (_: Exception) {} }
            try { r.startRecording() } catch (_: Exception) { r.release(); continue }
            if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) { r.release(); continue }
            return r to rate
        }
        return null
    }

    /** Наш запис система приглушила (інша програма тримає мікрофон) — тоді тиша не означає «німу» гарнітуру. */
    private fun silenced(r: AudioRecord) = Build.VERSION.SDK_INT >= 29 && try { r.activeRecordingConfiguration?.isClientSilenced == true } catch (_: Exception) { false }

    private fun loop(r: AudioRecord, inRate: Int, w: ParcelFileDescriptor) {
        val step = inRate / RATE                               // 1 або 3
        val inBuf = ShortArray(inRate / 50)                    // 20 мс
        val n16 = inBuf.size / step                            // 320 відліків = 640 байт: менше PIPE_BUF, пишеться цілком
        val pcm = IntArray(n16)
        val bytes = ByteArray(n16 * 2)
        val pfd = arrayOf(StructPollfd().apply { fd = w.fileDescriptor; events = OsConstants.POLLOUT.toShort() })
        var env = 1500.0                                       // «гучність мови» з повільним спадом — від неї рахуємо підсилення
        var gain = if (gainOn) 2.0 else 1.0
        val t0 = SystemClock.elapsedRealtime()
        var rawPeak = 0
        var checked = spare == null
        var lastLvl = 0L
        var drops = 0
        try {
            while (running) {
                var got = 0
                while (got < inBuf.size && running) {
                    val n = r.read(inBuf, got, inBuf.size - got)
                    if (n < 0) throw IOException("read $n")
                    got += n
                }
                if (!running) break

                var sum = 0.0
                var peak = 0
                for (j in 0 until n16) {
                    var s = 0
                    for (k in 0 until step) s += inBuf[j * step + k]
                    s /= step                                  // 48 → 16 кГц: середнє з трьох — заодно простий фільтр
                    pcm[j] = s
                    val a = abs(s)
                    if (a > peak) peak = a
                    sum += s.toDouble() * s
                }
                val rms = sqrt(sum / n16)

                // «Німа» гарнітура: за 1,2 с жодного звуку (навіть шуму) — переходимо на мікрофон телефона
                if (!checked) {
                    if (peak > rawPeak) rawPeak = peak
                    if (SystemClock.elapsedRealtime() - t0 > 1200) {
                        checked = true
                        val sp = spare
                        if (rawPeak <= 2 && sp != null && !silenced(r)) {
                            try { r.setPreferredDevice(sp); device = sp; onSwitch(sp) } catch (_: Exception) {}
                        }
                    }
                }

                // Підсилення тихого мікрофона: мова ≈ −20 дБ від максимуму; не більш як ×12, гучне — одразу тихіше
                if (gainOn) {
                    env = maxOf(rms, env * 0.997)
                    val want = (3000.0 / maxOf(env, 250.0)).coerceIn(1.0, 12.0)
                    gain = if (want < gain) want else gain + (want - gain) * 0.05
                }
                var sum2 = 0.0
                for (j in 0 until n16) {
                    val v = (pcm[j] * gain).toInt().coerceIn(-32768, 32767)
                    bytes[2 * j] = (v and 0xff).toByte()
                    bytes[2 * j + 1] = ((v shr 8) and 0xff).toByte()
                    sum2 += v.toDouble() * v
                }
                val now = SystemClock.elapsedRealtime()
                if (now - lastLvl >= 80) {
                    lastLvl = now
                    val db = 20 * log10(maxOf(sqrt(sum2 / n16), 1.0) / 32768.0)
                    onLevel(((db + 60) / 50).toFloat().coerceIn(0f, 1f))
                }

                // У трубу — лише коли розпізнавач забирає звук. Не забирає — кадр пропускаємо, запис не зависає.
                pfd[0].revents = 0
                val ready = try { Os.poll(pfd, 0) > 0 } catch (_: ErrnoException) { false }
                val ev = pfd[0].revents.toInt()
                if ((ev and (OsConstants.POLLERR or OsConstants.POLLHUP)) != 0) break      // розпізнавач закрив трубу
                if (ready && (ev and OsConstants.POLLOUT) != 0) { drops = 0; Os.write(w.fileDescriptor, bytes, 0, bytes.size) }
                else if (++drops == 25) onStall()
            }
        } catch (_: Exception) {
        } finally {
            try { r.stop() } catch (_: Exception) {}
            r.release()
            try { w.close() } catch (_: Exception) {}
        }
    }
}

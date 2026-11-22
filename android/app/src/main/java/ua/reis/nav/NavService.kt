package ua.reis.nav

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.GnssMeasurementsEvent
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import kotlin.math.sqrt

/**
 * Фонова служба: тримає GPS і датчики живими, коли екран вимкнено або застосунок згорнуто.
 * Шле в інтерфейс: loc (GPS і мережеве місце), gnss (супутники), sens (поворот, вібрація, тиск).
 */
class NavService : Service(), SensorEventListener {

    companion object {
        const val CH_NAV = "nav"
        const val CH_ALERT = "alerts"
        private const val NOTIF_ID = 1

        fun ensureChannels(ctx: Context) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(NotificationChannel(CH_NAV, ctx.getString(R.string.notif_nav_channel), NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CH_ALERT, ctx.getString(R.string.notif_alert_channel), NotificationManager.IMPORTANCE_HIGH))
        }
    }

    private lateinit var lm: LocationManager
    private lateinit var sm: SensorManager
    private val handler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var started = false

    // датчики
    private val grav = FloatArray(3)
    private var hasGrav = false
    private var yawCw = 0.0                 // накопичений поворот за годинниковою стрілкою, градуси
    private var hasGyro = false
    private var lastGyroNs = 0L
    private var accSum = 0.0
    private var accSq = 0.0
    private var accN = 0
    private var heading: Float? = null
    private var pressure: Float? = null
    private val rot = FloatArray(9)
    private val ori = FloatArray(3)
    private var lastGnssMs = 0L
    private var tick = 0
    private var gpsRequested = false
    private var locError = ""

    private fun emit(type: String, o: JSONObject) { MainActivity.instance?.emit(type, o.toString()) }

    private fun locJson(l: Location, prov: String): JSONObject {
        val o = JSONObject()
        o.put("lat", l.latitude).put("lon", l.longitude).put("t", l.time).put("prov", prov)
        if (l.hasAccuracy() && l.accuracy.isFinite()) o.put("acc", l.accuracy.toDouble())
        if (l.hasSpeed() && l.speed.isFinite()) o.put("spd", l.speed.toDouble())
        if (l.hasBearing() && l.bearing.isFinite() && l.hasSpeed() && l.speed > 0.7f) o.put("brg", l.bearing.toDouble())
        if (l.hasAltitude() && l.altitude.isFinite()) o.put("alt", l.altitude)
        @Suppress("DEPRECATION")
        val mock = l.isFromMockProvider
        if (mock) o.put("mock", true)
        return o
    }

    private open inner class Listener(val prov: String) : LocationListener {
        override fun onLocationChanged(location: Location) { emit("loc", locJson(location, prov)) }
        override fun onProviderEnabled(provider: String) { emitState() }
        override fun onProviderDisabled(provider: String) { emitState() }
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    private val gpsListener = Listener("gps")
    private val netListener = Listener("network")
    private val fusedListener = Listener("fused")

    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun enabled(p: String) = try { lm.isProviderEnabled(p) } catch (_: Exception) { false }

    /** Стан геолокації телефона: інтерфейс показує, що саме заважає (вимкнено, немає дозволу тощо). */
    private fun emitState() {
        val gps = enabled(LocationManager.GPS_PROVIDER)
        val net = enabled(LocationManager.NETWORK_PROVIDER)
        val on = if (Build.VERSION.SDK_INT >= 28) (try { lm.isLocationEnabled } catch (_: Exception) { gps || net }) else (gps || net)
        val o = JSONObject().put("enabled", on).put("gps", gps).put("network", net)
            .put("fine", has(Manifest.permission.ACCESS_FINE_LOCATION)).put("coarse", has(Manifest.permission.ACCESS_COARSE_LOCATION))
            .put("listening", gpsRequested)
        if (locError.isNotEmpty()) o.put("error", locError)
        emit("locstate", o)
    }

    /** Останнє відоме місце: щоб одразу після запуску показати хоча б приблизну точку. */
    @SuppressLint("MissingPermission")
    private fun emitLastKnown() {
        if (!has(Manifest.permission.ACCESS_COARSE_LOCATION) && !has(Manifest.permission.ACCESS_FINE_LOCATION)) return
        var best: Location? = null
        val names = arrayListOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        if (Build.VERSION.SDK_INT >= 31) names.add(LocationManager.FUSED_PROVIDER)
        for (n in names) {
            val l = try { lm.getLastKnownLocation(n) } catch (_: Exception) { null } ?: continue
            if (best == null || l.time > best.time) best = l
        }
        val b = best ?: return
        val o = locJson(b, "last").put("age", (System.currentTimeMillis() - b.time) / 1000)
        emit("loc", o)
    }

    private val gnssCallback = object : GnssStatus.Callback() {
        override fun onSatelliteStatusChanged(status: GnssStatus) {
            val now = System.currentTimeMillis()
            if (now - lastGnssMs < 3000) return
            lastGnssMs = now
            var used = 0
            var sum = 0.0
            val n = status.satelliteCount
            for (i in 0 until n) if (status.usedInFix(i)) { used++; sum += status.getCn0DbHz(i) }
            val o = JSONObject().put("vis", n).put("used", used)
            if (used > 0) o.put("cn0", sum / used)
            emit("gnss", o)
        }
    }

    // Сирі вимірювання GNSS: підсилення приймача (AGC) і сила сигналу (C/N0). Глушіння — AGC і C/N0 падають;
    // підміна — сильний «чистий» сигнал при зниженому AGC. Рішення ухвалює веб-частина з власним еталоном телефона.
    private var lastMeasMs = 0L
    private val measCallback = object : GnssMeasurementsEvent.Callback() {
        @Suppress("DEPRECATION")
        override fun onGnssMeasurementsReceived(event: GnssMeasurementsEvent) {
            val now = System.currentTimeMillis()
            if (now - lastMeasMs < 2000) return
            lastMeasMs = now
            var agcSum = 0.0; var agcN = 0; var cnSum = 0.0; var cnN = 0
            for (m in event.measurements) {
                if (m.hasAutomaticGainControlLevelDb()) { agcSum += m.automaticGainControlLevelDb; agcN++ }
                val cn = m.cn0DbHz
                if (cn > 0) { cnSum += cn; cnN++ }
            }
            val o = JSONObject().put("n", event.measurements.size)
            if (agcN > 0) o.put("agc", agcSum / agcN)
            if (cnN > 0) o.put("cn0", cnSum / cnN)
            emit("gnssq", o)
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            val o = JSONObject()
            if (accN >= 10) {
                val mean = accSum / accN
                val v = accSq / accN - mean * mean
                if (v.isFinite()) o.put("var", if (v < 0) 0.0 else v)
            }
            accSum = 0.0; accSq = 0.0; accN = 0
            if (hasGyro) o.put("yaw", yawCw)
            if (++tick % 5 == 0) emitState()
            heading?.let { if (it.isFinite()) o.put("hdg", it.toDouble()) }
            pressure?.let { if (it.isFinite()) o.put("press", it.toDouble()) }
            if (o.length() > 0) emit("sens", o)
            handler.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        sm = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            else startForeground(NOTIF_ID, n)
        } catch (e: Exception) {
            Log.w("Reis", "startForeground failed", e)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!started) {
            started = true
            startLocation()
            startSensors()
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "reis:nav").also { it.setReferenceCounted(false); it.acquire() }
            handler.postDelayed(ticker, 1000)
        } else {
            emitState()
            emitLastKnown()
        }
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CH_NAV)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(getString(R.string.notif_nav_title))
            .setContentText(getString(R.string.notif_nav_text))
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    @SuppressLint("MissingPermission")
    private fun startLocation() {
        val fine = has(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = has(Manifest.permission.ACCESS_COARSE_LOCATION)
        val providers = try { lm.allProviders } catch (_: Exception) { emptyList<String>() }
        locError = ""
        if (fine) {
            try {
                if (providers.contains(LocationManager.GPS_PROVIDER)) {
                    lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, gpsListener, Looper.getMainLooper())
                    gpsRequested = true
                } else locError = "no gps provider"
            } catch (e: Exception) { locError = "gps: " + e.javaClass.simpleName; Log.w("Reis", "gps provider", e) }
            try {
                // Злите місце (GPS + вишки + Wi-Fi) від Android 12: швидка приблизна точка в приміщенні.
                if (Build.VERSION.SDK_INT >= 31 && providers.contains(LocationManager.FUSED_PROVIDER))
                    lm.requestLocationUpdates(LocationManager.FUSED_PROVIDER, 2000L, 0f, fusedListener, Looper.getMainLooper())
            } catch (e: Exception) { Log.w("Reis", "fused provider", e) }
            try {
                lm.registerGnssStatusCallback(gnssCallback, handler)
            } catch (e: Exception) { Log.w("Reis", "gnss status", e) }
            try {
                lm.registerGnssMeasurementsCallback(measCallback, handler)
            } catch (e: Exception) { Log.w("Reis", "gnss measurements", e) }
        }
        if (fine || coarse) {
            try {
                // Мережеве місце (вишки, Wi-Fi) — звірка для детектора підміни GPS.
                if (providers.contains(LocationManager.NETWORK_PROVIDER))
                    lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10000L, 0f, netListener, Looper.getMainLooper())
            } catch (e: Exception) { Log.w("Reis", "network provider", e) }
        }
        emitState()
        emitLastKnown()
    }

    private fun startSensors() {
        val reg = { type: Int, rate: Int -> sm.getDefaultSensor(type)?.let { sm.registerListener(this, it, rate) } }
        reg(Sensor.TYPE_ACCELEROMETER, SensorManager.SENSOR_DELAY_GAME)
        hasGyro = reg(Sensor.TYPE_GYROSCOPE, SensorManager.SENSOR_DELAY_GAME) == true
        reg(Sensor.TYPE_ROTATION_VECTOR, SensorManager.SENSOR_DELAY_NORMAL)
        reg(Sensor.TYPE_PRESSURE, SensorManager.SENSOR_DELAY_NORMAL)
    }

    override fun onSensorChanged(e: SensorEvent) {
        when (e.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> {
                val x = e.values[0]; val y = e.values[1]; val z = e.values[2]
                if (!hasGrav) { grav[0] = x; grav[1] = y; grav[2] = z; hasGrav = true }
                else { grav[0] = 0.92f * grav[0] + 0.08f * x; grav[1] = 0.92f * grav[1] + 0.08f * y; grav[2] = 0.92f * grav[2] + 0.08f * z }
                val m = sqrt((x * x + y * y + z * z).toDouble())
                accSum += m; accSq += m * m; accN++
            }
            Sensor.TYPE_GYROSCOPE -> {
                // Поворот машини = обертання навколо вертикалі, як би телефон не стояв у тримачі.
                if (hasGrav && lastGyroNs != 0L) {
                    val dt = (e.timestamp - lastGyroNs) / 1e9
                    val g = sqrt((grav[0] * grav[0] + grav[1] * grav[1] + grav[2] * grav[2]).toDouble())
                    if (dt > 0 && dt < 0.5 && g > 1.0) {
                        val aroundUp = (e.values[0] * grav[0] + e.values[1] * grav[1] + e.values[2] * grav[2]) / g   // рад/с, проти год. стрілки
                        yawCw -= Math.toDegrees(aroundUp * dt)
                    }
                }
                lastGyroNs = e.timestamp
            }
            Sensor.TYPE_ROTATION_VECTOR -> {
                try {
                    SensorManager.getRotationMatrixFromVector(rot, e.values)
                    SensorManager.getOrientation(rot, ori)
                    heading = ((Math.toDegrees(ori[0].toDouble()) + 360.0) % 360.0).toFloat()
                } catch (_: Exception) {}
            }
            Sensor.TYPE_PRESSURE -> pressure = e.values[0]
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        try { lm.removeUpdates(gpsListener) } catch (_: Exception) {}
        try { lm.removeUpdates(netListener) } catch (_: Exception) {}
        try { lm.removeUpdates(fusedListener) } catch (_: Exception) {}
        try { lm.unregisterGnssStatusCallback(gnssCallback) } catch (_: Exception) {}
        try { lm.unregisterGnssMeasurementsCallback(measCallback) } catch (_: Exception) {}
        try { sm.unregisterListener(this) } catch (_: Exception) {}
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        started = false
        super.onDestroy()
    }
}

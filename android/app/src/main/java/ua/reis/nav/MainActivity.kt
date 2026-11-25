package ua.reis.nav

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/** Єдиний екран: WebView з інтерфейсом. Уся «залізна» робота — в NavService і Bridge. */
class MainActivity : Activity() {

    companion object {
        @Volatile var instance: MainActivity? = null
        private const val REQ_LOCATION = 11
        private const val REQ_MIC = 12
        private const val BG = "#13171C"
    }

    lateinit var web: WebView
        private set
    private lateinit var bridge: Bridge
    private var jsReady = false
    private val pending = ArrayList<String>()
    private var micThen: (() -> Unit)? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    var userAgent: String = "ReisNav"
        private set

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.parseColor(BG)
        window.navigationBarColor = Color.parseColor(BG)

        WebStore.init(this)
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor(BG))
        setContentView(web)

        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.setSupportZoom(false)
        s.textZoom = 100
        s.cacheMode = WebSettings.LOAD_DEFAULT
        userAgent = s.userAgentString + " ReisNav/" + BuildConfig.VERSION_NAME
        s.userAgentString = userAgent

        bridge = Bridge(this)
        web.addJavascriptInterface(bridge, "ReisNative")

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val u = request.url
                if (u.host != WebStore.HOST) return null
                val path = u.path ?: "/"
                if (path == "/offline/" + OfflineMap.NAME) return OfflineMap.serve(this@MainActivity, request.requestHeaders, u.query)
                return WebStore.serve(this@MainActivity, path)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == WebStore.HOST) return false
                // Чужі сторінки всередині застосунку не відкриваємо: місток ReisNative бачить лише наш інтерфейс.
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("ReisWeb", m.message() + " @" + m.sourceId() + ":" + m.lineNumber())
                return true
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, false, false)       // місце дає NavService, не браузер
            }
        }
        watchNetwork()
        web.loadUrl("https://" + WebStore.HOST + "/index.html")
    }

    /** WebView сам не знає, чи є мережа: повідомляємо, щоб інтерфейс перемикався на збережену карту. */
    private fun watchNetwork() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            web.setNetworkAvailable(cm.activeNetwork != null)
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { runOnUiThread { web.setNetworkAvailable(true) } }
                override fun onLost(network: Network) { runOnUiThread { web.setNetworkAvailable(cm.activeNetwork != null) } }
            }
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (e: Exception) {
            Log.w("Reis", "network watch failed", e)
        }
    }

    /* ---------- події для інтерфейсу ---------- */
    fun emit(type: String, json: String) {
        val js = "window.__reis&&window.__reis('$type',$json)"
        runOnUiThread {
            if (jsReady) web.evaluateJavascript(js, null)
            else if (type != "loc" && type != "sens" && type != "gnss" && pending.size < 50) pending.add(js)
        }
    }

    /** Нова версія інтерфейсу вже розпакована: перезавантажуємо сторінку без перезапуску застосунку.
     *  Служба з GPS при цьому працює далі, тож місце не губиться. */
    fun reloadUi() = runOnUiThread {
        jsReady = false
        pending.clear()
        WebStore.init(this)
        web.loadUrl("https://" + WebStore.HOST + "/index.html")
    }

    fun onJsReady() {
        WebStore.bootOk(this)
        runOnUiThread {
            jsReady = true
            for (p in pending) web.evaluateJavascript(p, null)
            pending.clear()
        }
    }

    /* ---------- дозволи ---------- */
    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    fun startTracking() {
        if (has(Manifest.permission.ACCESS_FINE_LOCATION)) { startNav(); return }
        val list = arrayListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) list.add(Manifest.permission.POST_NOTIFICATIONS)
        requestPermissions(list.toTypedArray(), REQ_LOCATION)
    }

    private fun startNav() {
        try {
            startForegroundService(Intent(this, NavService::class.java))
        } catch (e: Exception) {
            Log.w("Reis", "service start failed", e)
            emit("perm", JSONObject().put("loc", true).put("service", false).put("error", e.javaClass.simpleName).toString())
        }
    }

    fun stopTracking() {
        stopService(Intent(this, NavService::class.java))
    }

    fun withMic(then: () -> Unit) {
        if (has(Manifest.permission.RECORD_AUDIO)) { then(); return }
        micThen = then
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_LOCATION) {
            val ok = has(Manifest.permission.ACCESS_FINE_LOCATION)
            emit("perm", JSONObject().put("loc", ok).toString())
            if (ok) startNav()
        } else if (requestCode == REQ_MIC) {
            val ok = has(Manifest.permission.RECORD_AUDIO)
            val t = micThen
            micThen = null
            if (ok) t?.invoke() else emit("stt", JSONObject().put("state", "error").put("code", "denied").toString())
        }
    }

    /* ---------- вікно поверх інших програм («картинка в картинці», як у Google Maps) ----------
       Інтерфейс каже, чи воно потрібне (рейс іде й у налаштуваннях дозволено). Тоді, щойно водій іде з програми — «Додому»,
       інша програма, дотик до сповіщення про дзвінок чи повідомлення, — «Рейс» не зникає, а лишається маленьким вікном
       поверх усього. Розмір вікна міняє сама система (розтягнути двома пальцями, подвійний дотик), «розгорнути» — назад на весь екран. */
    @Volatile private var pipWanted = false

    private fun pipSupported() = try { packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) } catch (_: Exception) { false }

    private fun pipParams(): PictureInPictureParams {
        val land = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val b = PictureInPictureParams.Builder().setAspectRatio(if (land) Rational(4, 3) else Rational(3, 4))
        if (Build.VERSION.SDK_INT >= 31) {
            b.setAutoEnterEnabled(pipWanted)          // Android 12+: жест «Додому» сам плавно згортає у вікно
            b.setSeamlessResizeEnabled(true)          // вміст перемальовується під час зміни розміру (у нас карта, не відео)
        }
        return b.build()
    }

    /** Інтерфейс: вікно потрібне / не потрібне. Повертає, чи телефон узагалі це вміє. */
    fun setPip(on: Boolean): Boolean {
        val ok = pipSupported()
        pipWanted = on && ok
        if (ok) runOnUiThread { try { setPictureInPictureParams(pipParams()) } catch (e: Exception) { Log.w("Reis", "pip params failed", e) } }
        return ok
    }

    /** Згорнути у вікно. true — вдалося (або програма вже у вікні). */
    private fun enterPip(): Boolean {
        if (!pipWanted || isFinishing) return false
        if (isInPictureInPictureMode) return true
        return try { enterPictureInPictureMode(pipParams()) } catch (e: Exception) { Log.w("Reis", "enter pip failed", e); false }
    }

    /** Водій сам іде з програми (не вимкнув екран і не закрив її): «Додому», перемикання програм, дотик до сповіщення. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        emit("pip", JSONObject().put("on", isInPictureInPictureMode).toString())
    }

    /** Телефон повернули — вікно має стати лежачим чи стоячим відповідно. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (pipWanted && !isInPictureInPictureMode) try { setPictureInPictureParams(pipParams()) } catch (_: Exception) {}
    }

    /* ---------- життєвий цикл ---------- */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // «Назад» спершу закриває відкриту панель; якщо закривати нічого — згортаємо, навігація триває.
        web.evaluateJavascript("(window.__reisBack&&window.__reisBack())?1:0") { r ->
            // рейс іде й вікно поверх інших програм дозволено — «Назад» із карти теж лишає його на екрані, а не ховає програму
            if (r != "1" && !enterPip()) moveTaskToBack(true)
        }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        try {
            netCallback?.let { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) }
        } catch (_: Exception) {}
        bridge.shutdown()
        if (isFinishing) stopTracking()
        web.removeJavascriptInterface("ReisNative")
        web.destroy()
        super.onDestroy()
    }
}

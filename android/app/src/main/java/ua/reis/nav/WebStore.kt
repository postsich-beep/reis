package ua.reis.nav

import android.content.Context
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.zip.ZipInputStream

/**
 * Звідки береться інтерфейс: з вбудованої в APK папки assets/web або з новішої версії,
 * завантаженої «повітрям» у files/web/<номер>. Якщо завантажена версія не запустилась — відкат на вбудовану.
 */
object WebStore {
    const val HOST = "appassets.androidplatform.net"

    var bundledVersion = 0
        private set
    var activeVersion = 0
        private set
    private var otaDir: File? = null

    private fun root(ctx: Context) = File(ctx.filesDir, "web")
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("webstore", Context.MODE_PRIVATE)

    private fun readVersion(text: String): Int = try { JSONObject(text).optInt("web", 0) } catch (_: Exception) { 0 }

    fun init(ctx: Context) {
        bundledVersion = try { readVersion(ctx.assets.open("web/version.json").bufferedReader().use { it.readText() }) } catch (_: Exception) { 0 }
        activeVersion = bundledVersion
        otaDir = null
        val p = prefs(ctx)
        val cur = p.getInt("current", 0)
        if (cur > bundledVersion) {
            val dir = File(root(ctx), cur.toString())
            if (p.getBoolean("bootPending", false)) {
                // Минулого разу ця версія не дійшла до готовності — більше її не чіпаємо.
                p.edit().putInt("current", 0).putBoolean("bootPending", false).apply()
                dir.deleteRecursively()
            } else if (File(dir, "index.html").isFile) {
                otaDir = dir
                activeVersion = cur
                p.edit().putBoolean("bootPending", true).apply()
            }
        } else if (cur != 0) {
            p.edit().putInt("current", 0).putBoolean("bootPending", false).apply()
            root(ctx).deleteRecursively()
        }
    }

    /** Інтерфейс доповів, що запустився: завантажена версія робоча. */
    fun bootOk(ctx: Context) { prefs(ctx).edit().putBoolean("bootPending", false).apply() }

    private fun mime(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "webmanifest" -> "application/manifest+json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "woff2" -> "font/woff2"
        "txt" -> "text/plain"
        else -> "application/octet-stream"
    }

    fun serve(ctx: Context, rawPath: String): WebResourceResponse {
        var p = rawPath.trimStart('/')
        if (p.isEmpty()) p = "index.html"
        val headers = mapOf("Cache-Control" to "no-cache", "Access-Control-Allow-Origin" to "*")
        if (p.contains("..")) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        val m = mime(p)
        val enc = if (m.startsWith("text/") || m.endsWith("json") || m.endsWith("xml")) "utf-8" else null
        return try {
            val dir = otaDir
            val f = if (dir != null) File(dir, p) else null
            val stream: InputStream = if (f != null && f.isFile) f.inputStream() else ctx.assets.open("web/$p")
            WebResourceResponse(m, enc, 200, "OK", headers, stream)
        } catch (_: IOException) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        }
    }

    /** Розпаковує завантажений web.zip у нову папку версії. Повертає номер версії або кидає виняток. */
    fun install(ctx: Context, zip: InputStream): Int {
        val tmp = File(root(ctx), "tmp")
        tmp.deleteRecursively()
        tmp.mkdirs()
        val base = tmp.canonicalPath + File.separator
        var total = 0L
        ZipInputStream(zip).use { zis ->
            while (true) {
                val e = zis.nextEntry ?: break
                val out = File(tmp, e.name)
                if (!out.canonicalPath.startsWith(base)) throw IOException("bad zip entry")      // захист від «../»
                if (e.isDirectory) { out.mkdirs(); continue }
                out.parentFile?.mkdirs()
                out.outputStream().use { os ->
                    val buf = ByteArray(16384)
                    while (true) {
                        val n = zis.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > 40L * 1024 * 1024) throw IOException("zip too large")
                        os.write(buf, 0, n)
                    }
                }
            }
        }
        if (!File(tmp, "index.html").isFile) throw IOException("no index.html")
        val ver = readVersion(File(tmp, "version.json").takeIf { it.isFile }?.readText() ?: "")
        if (ver <= activeVersion) { tmp.deleteRecursively(); throw IOException("not newer") }
        val dst = File(root(ctx), ver.toString())
        dst.deleteRecursively()
        if (!tmp.renameTo(dst)) throw IOException("rename failed")
        prefs(ctx).edit().putInt("current", ver).putBoolean("bootPending", false).apply()
        return ver
    }
}

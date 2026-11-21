package ua.reis.nav

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile

/**
 * Офлайн-карта України: один файл PMTiles (~1 ГБ) у папці застосунку.
 * Завантажує системний DownloadManager (докачування, сповіщення, «лише Wi-Fi»),
 * а WebView читає файл шматками через запити з заголовком Range.
 */
object OfflineMap {
    const val NAME = "ukraine.pmtiles"
    private const val PREFS = "offline"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun dir(ctx: Context): File = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "maps").apply { mkdirs() }
    fun file(ctx: Context) = File(dir(ctx), NAME)
    private fun part(ctx: Context) = File(dir(ctx), "$NAME.part")
    private fun dm(ctx: Context) = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    fun url(repo: String, file: String) = "https://github.com/$repo/releases/download/offline-map/$file"

    /** Почати завантаження. remoteDate і remoteSize — з offline.json, щоб потім показати версію карти. */
    fun start(ctx: Context, repo: String, wifiOnly: Boolean, remoteDate: String, remoteSize: Long) {
        cancel(ctx)
        part(ctx).delete()
        val rq = DownloadManager.Request(Uri.parse(url(repo, NAME)))
            .setTitle(ctx.getString(R.string.offline_title))
            .setDescription(ctx.getString(R.string.offline_desc))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(ctx, "maps", "$NAME.part")
            .setAllowedOverMetered(!wifiOnly)
            .setAllowedOverRoaming(!wifiOnly)
        val id = dm(ctx).enqueue(rq)
        prefs(ctx).edit().putLong("dlId", id).putString("dlDate", remoteDate).putLong("dlSize", remoteSize).apply()
    }

    fun cancel(ctx: Context) {
        val id = prefs(ctx).getLong("dlId", -1L)
        if (id >= 0) try { dm(ctx).remove(id) } catch (_: Exception) {}
        prefs(ctx).edit().remove("dlId").apply()
        part(ctx).delete()
    }

    fun delete(ctx: Context) {
        cancel(ctx)
        file(ctx).delete()
        prefs(ctx).edit().remove("date").remove("size").apply()
    }

    /** Стан: чи є карта, і як іде завантаження. Заодно завершує завантаження, що скінчилось, поки застосунок був закритий. */
    fun status(ctx: Context): JSONObject {
        val p = prefs(ctx)
        val o = JSONObject()
        val f = file(ctx)
        o.put("installed", f.isFile && f.length() > 0)
        if (f.isFile) o.put("size", f.length()).put("date", p.getString("date", "") ?: "")
        try { o.put("free", dir(ctx).usableSpace) } catch (_: Exception) {}
        val id = p.getLong("dlId", -1L)
        if (id < 0) return o.put("dl", JSONObject().put("state", "none"))
        val dl = JSONObject()
        try {
            dm(ctx).query(DownloadManager.Query().setFilterById(id)).use { c ->
                if (!c.moveToFirst()) {
                    p.edit().remove("dlId").apply()
                    dl.put("state", "none")
                } else {
                    val st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    val done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    var total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    if (total <= 0) total = p.getLong("dlSize", 0L)
                    val reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                    dl.put("done", done).put("total", total).put("reason", reason)
                    when (st) {
                        DownloadManager.STATUS_SUCCESSFUL -> {
                            val pf = part(ctx)
                            if (pf.isFile && pf.length() > 0) {
                                f.delete()
                                if (pf.renameTo(f)) {
                                    p.edit().putString("date", p.getString("dlDate", "")).putLong("size", f.length()).remove("dlId").apply()
                                    dl.put("state", "done")
                                    o.put("installed", true).put("size", f.length()).put("date", p.getString("date", "") ?: "")
                                } else dl.put("state", "failed").put("error", "rename")
                            } else { dl.put("state", "failed").put("error", "nofile"); p.edit().remove("dlId").apply() }
                        }
                        DownloadManager.STATUS_FAILED -> { dl.put("state", "failed"); p.edit().remove("dlId").apply(); part(ctx).delete() }
                        DownloadManager.STATUS_PAUSED -> dl.put("state", "paused")
                        DownloadManager.STATUS_PENDING -> dl.put("state", "pending")
                        else -> dl.put("state", "running")
                    }
                }
            }
        } catch (e: Exception) { dl.put("state", "failed").put("error", e.javaClass.simpleName) }
        return o.put("dl", dl)
    }

    /** Віддати шматок файлу на запит WebView (pmtiles читає заголовок і тайли через Range). */
    fun serve(ctx: Context, headers: Map<String, String>?): WebResourceResponse {
        val cors = mutableMapOf("Access-Control-Allow-Origin" to "*", "Accept-Ranges" to "bytes", "Cache-Control" to "no-cache")
        val f = file(ctx)
        if (!f.isFile) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", cors, ByteArrayInputStream(ByteArray(0)))
        val len = f.length()
        val range = headers?.entries?.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        var start = 0L
        var end = len - 1
        var partial = false
        if (range != null) {
            val m = Regex("bytes=(\\d*)-(\\d*)").find(range)
            if (m != null) {
                val a = m.groupValues[1]
                val b = m.groupValues[2]
                if (a.isEmpty() && b.isNotEmpty()) { start = (len - b.toLong()).coerceAtLeast(0) }
                else {
                    start = a.toLongOrNull() ?: 0L
                    if (b.isNotEmpty()) end = minOf(b.toLong(), len - 1)
                }
                partial = true
            }
        }
        if (start > end || start >= len) {
            cors["Content-Range"] = "bytes */$len"
            return WebResourceResponse("application/octet-stream", null, 416, "Range Not Satisfiable", cors, ByteArrayInputStream(ByteArray(0)))
        }
        val count = end - start + 1
        cors["Content-Length"] = count.toString()
        if (partial) cors["Content-Range"] = "bytes $start-$end/$len"
        return WebResourceResponse("application/octet-stream", null, if (partial) 206 else 200, if (partial) "Partial Content" else "OK", cors, Slice(f, start, count))
    }

    /** Потік, що читає count байтів файлу з позиції start. */
    private class Slice(f: File, start: Long, private var left: Long) : InputStream() {
        private val raf = RandomAccessFile(f, "r").also { it.seek(start) }
        override fun read(): Int {
            if (left <= 0) return -1
            val v = raf.read()
            if (v >= 0) left--
            return v
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = raf.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun available(): Int = minOf(left, Int.MAX_VALUE.toLong()).toInt()
        override fun close() { raf.close() }
    }
}

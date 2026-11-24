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

    /**
     * Віддати шматок файлу карти на запит WebView. Два способи (1.1.13):
     *  1) ?r=ПОЧАТОК-КІНЕЦЬ в адресі — рівно ці байти, без заголовка Range. Так читає карта: нічого не залежить від WebView.
     *  2) заголовок Range. WebView обробляє його САМ: питає в нашого потоку available() (чекає розмір УСЬОГО файлу)
     *     і викликає skip(початок шматка). До 1.1.12 ми віддавали вже відрізаний шматок — WebView шукав початок усередині
     *     нього й відповідав «range not satisfiable»: з файлу читався лише заголовок (з нуля), а жоден тайл — ні.
     *     Звідси «сіра карта без доріг». Тепер потік поводиться як увесь файл і обривається на кінці шматка.
     */
    fun serve(ctx: Context, headers: Map<String, String>?, query: String? = null): WebResourceResponse {
        val cors = mutableMapOf("Access-Control-Allow-Origin" to "*", "Accept-Ranges" to "bytes", "Cache-Control" to "no-cache")
        val f = file(ctx)
        if (!f.isFile) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", cors, ByteArrayInputStream(ByteArray(0)))
        val len = f.length()
        val bin = "application/octet-stream"
        val unsat = {
            cors["Content-Range"] = "bytes */$len"
            WebResourceResponse(bin, null, 416, "Range Not Satisfiable", cors, ByteArrayInputStream(ByteArray(0)))
        }
        // 1) шматок задано в адресі
        val q = if (query != null) Regex("(?:^|&)r=(\\d{1,18})-(\\d{1,18})(?:&|$)").find(query) else null
        if (q != null) {
            val s0 = q.groupValues[1].toLong()
            val e0 = minOf(q.groupValues[2].toLong(), len - 1)
            if (s0 > e0) return unsat()
            val n = e0 - s0 + 1
            cors["Content-Length"] = n.toString()
            cors["X-Reis-Range"] = "$s0-$e0/$len"
            return WebResourceResponse(bin, null, 200, "OK", cors, Slice(f, s0, n))
        }
        // 2) заголовок Range
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
        if (start > end || start >= len) return unsat()
        val count = end - start + 1
        cors["Content-Length"] = count.toString()
        if (!partial) return WebResourceResponse(bin, null, 200, "OK", cors, Slice(f, 0, len))
        cors["Content-Range"] = "bytes $start-$end/$len"
        return WebResourceResponse(bin, null, 206, "Partial Content", cors, Ranged(f, start, end, len))
    }

    /** Потік, що читає count байтів файлу з позиції start (для запитів без Range: WebView нічого не перемотує). */
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

    /**
     * Потік для запиту з Range. Для WebView це «увесь файл»: available() каже повну довжину, skip() перемотує миттєво
     * (а не читає й викидає сотні мегабайтів), читання закінчується на кінці шматка. Якщо читання почалось без skip() —
     * стаємо на початок шматка самі.
     */
    private class Ranged(f: File, private val start: Long, private val end: Long, private val total: Long) : InputStream() {
        private val raf = RandomAccessFile(f, "r")
        private var pos = 0L
        private var placed = false
        private fun place() {
            if (placed) return
            placed = true
            if (pos < start) { pos = start; raf.seek(pos) }
        }
        override fun available(): Int {
            val n = if (!placed) total else (end - pos + 1).coerceAtLeast(0L)
            return minOf(n, Int.MAX_VALUE.toLong()).toInt()
        }
        override fun skip(n: Long): Long {
            if (n <= 0) return 0
            val to = minOf(pos + n, total)
            val d = to - pos
            pos = to
            raf.seek(pos)
            placed = true
            return d
        }
        override fun read(): Int {
            place()
            if (pos > end) return -1
            val v = raf.read()
            if (v >= 0) pos++
            return v
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            place()
            if (pos > end) return -1
            if (len <= 0) return 0
            val n = raf.read(b, off, minOf(len.toLong(), end - pos + 1).toInt())
            if (n > 0) pos += n
            return n
        }
        override fun close() { raf.close() }
    }
}

package ua.reis.nav

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * Віддає завантажене оновлення (cache/upd/reis.apk) системному встановлювачу Android.
 * Лише цей один файл і лише на читання; назовні провайдер не відкритий — доступ дає тільки наш запит на встановлення.
 */
class ApkProvider : ContentProvider() {
    private fun file(uri: Uri): File {
        val f = File(File(context!!.cacheDir, "upd"), "reis.apk")
        if (uri.lastPathSegment != "reis.apk" || !f.exists()) throw FileNotFoundException(uri.toString())
        return f
    }

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = "application/vnd.android.package-archive"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode.contains('w')) throw SecurityException("read only")
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val f = file(uri)
        val cols: Array<String> = projection?.map { it }?.toTypedArray() ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val c = MatrixCursor(cols)
        val row = arrayOfNulls<Any>(cols.size)
        for (i in cols.indices) row[i] = when (cols[i]) {
            OpenableColumns.DISPLAY_NAME -> "reis.apk"
            OpenableColumns.SIZE -> f.length()
            else -> null
        }
        c.addRow(row)
        return c
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
}

package cc.lubeiluchen.rhine;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Explicit Android document pickers, without broad storage permissions. */
@CapacitorPlugin(name = "SshDocuments")
public class SshDocumentsPlugin extends RhinePlugin {
    private File root() { return new File(getContext().getCacheDir(), "ssh-transfers"); }
    private File task() throws IOException {
        File target = new File(root(), UUID.randomUUID().toString());
        if (!target.mkdirs()) throw new IOException("无法准备临时目录");
        return target;
    }
    private File owned(String path) throws IOException {
        File file = new File(path).getCanonicalFile();
        if (!file.getPath().startsWith(root().getCanonicalPath() + File.separator)) throw new IOException("无效的传输路径");
        return file;
    }
    private String name(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return clean(c.getString(0));
        }
        return "file";
    }
    private String clean(String name) {
        if (name == null || name.isEmpty() || name.equals(".") || name.equals("..")) return "file";
        return name.replace('/', '_').replace('\\', '_').replace('\0', '_');
    }
    private void choose(PluginCall call, Intent intent, String callback) {
        authorized(call, () -> getActivity().runOnUiThread(() -> startActivityForResult(call, intent, callback)));
    }
    @PluginMethod public void pickKey(PluginCall call) {
        choose(call, new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), "keyPicked");
    }
    @ActivityCallback private void keyPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { canceled(call); return; }
        authorized(call, () -> {
            try {
                Uri uri = result.getData().getData();
                ByteArrayOutputStream data = new ByteArrayOutputStream();
                try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                    byte[] buffer = new byte[8192]; int n;
                    while ((n = input.read(buffer)) >= 0) { if (data.size() + n > 512 * 1024) throw new IOException("私钥文件过大"); data.write(buffer, 0, n); }
                }
                JSObject value = new JSObject(); value.put("name", name(uri)); value.put("content", data.toString("UTF-8")); call.resolve(value);
            } catch (Exception error) { call.reject("无法读取私钥：" + error.getMessage()); }
        });
    }
    @PluginMethod public void pickFiles(PluginCall call) {
        boolean directory = call.getBoolean("directory", false);
        Intent intent = directory ? new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE) : new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        choose(call, intent, "filesPicked");
    }
    private void copyIn(Uri uri, File target) throws IOException {
        if (target.getParentFile().getUsableSpace() < 1024 * 1024) throw new IOException("手机临时空间不足");
        try (InputStream input = getContext().getContentResolver().openInputStream(uri); OutputStream output = new FileOutputStream(target)) { copy(input, output); }
    }
    private void copy(InputStream input, OutputStream output) throws IOException {
        if (input == null || output == null) throw new IOException("无法打开文件");
        byte[] buffer = new byte[65536]; int n;
        while ((n = input.read(buffer)) >= 0) { if (Thread.currentThread().isInterrupted()) throw new IOException("操作已取消"); output.write(buffer, 0, n); }
    }
    private void importTree(Uri tree, String id, File target, int depth, int[] count) throws IOException {
        if (depth > 32 || ++count[0] > 20000) throw new IOException("目录层数或文件数量过多");
        if (!target.mkdirs() && !target.isDirectory()) throw new IOException("无法准备目录");
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id);
        try (Cursor c = getContext().getContentResolver().query(children, new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null)) {
            if (c == null) throw new IOException("无法读取目录");
            while (c.moveToNext()) {
                String child = c.getString(0); File dest = unique(target, clean(c.getString(1)));
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) importTree(tree, child, dest, depth + 1, count);
                else { if (++count[0] > 20000) throw new IOException("文件数量过多"); copyIn(DocumentsContract.buildDocumentUriUsingTree(tree, child), dest); }
            }
        }
    }
    private File unique(File parent, String name) { File file = new File(parent, name); int i = 1; while (file.exists()) file = new File(parent, name + " (" + i++ + ")"); return file; }
    @ActivityCallback private void filesPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { canceled(call); return; }
        authorized(call, () -> {
            File dir = null;
            try {
                dir = task(); JSArray paths = new JSArray(); Intent data = result.getData();
                if (call.getBoolean("directory", false)) {
                    Uri tree = data.getData(); String id = DocumentsContract.getTreeDocumentId(tree);
                    File target = new File(dir, name(DocumentsContract.buildDocumentUriUsingTree(tree, id)));
                    importTree(tree, id, target, 0, new int[]{0}); paths.put(target.getPath());
                } else {
                    ClipData clip = data.getClipData(); int count = clip == null ? 1 : clip.getItemCount();
                    for (int i = 0; i < count; i++) { Uri uri = clip == null ? data.getData() : clip.getItemAt(i).getUri(); File target = unique(dir, name(uri)); copyIn(uri, target); paths.put(target.getPath()); }
                }
                JSObject value = new JSObject(); value.put("paths", paths); value.put("root", dir.getPath()); call.resolve(value);
            } catch (Exception error) { if (dir != null) erase(dir); call.reject("无法准备上传：" + error.getMessage()); }
        });
    }
    @PluginMethod public void downloadTarget(PluginCall call) { choose(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "targetPicked"); }
    @ActivityCallback private void targetPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { canceled(call); return; }
        authorized(call, () -> { try {
            Uri uri = result.getData().getData();
            getContext().getContentResolver().takePersistableUriPermission(uri, result.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
            JSObject value = new JSObject(); value.put("uri", uri.toString()); value.put("directory", task().getPath()); call.resolve(value);
        } catch (Exception error) { call.reject("无法打开下载目录：" + error.getMessage()); } });
    }
    private Uri exportTree(File source, Uri parent) throws IOException {
        String mime = source.isDirectory() ? DocumentsContract.Document.MIME_TYPE_DIR : "application/octet-stream";
        Uri created = DocumentsContract.createDocument(getContext().getContentResolver(), parent, mime, source.getName());
        if (created == null) throw new IOException("无法创建 " + source.getName());
        // Providers create a new document on conflicts; never open an existing document for overwrite.
        if (source.isDirectory()) { File[] children = source.listFiles(); if (children == null) throw new IOException("无法读取下载结果"); for (File child : children) exportTree(owned(child.getPath()), created); }
        else try (InputStream input = new FileInputStream(source); OutputStream output = getContext().getContentResolver().openOutputStream(created, "w")) { copy(input, output); }
        return created;
    }
    @PluginMethod public void publish(PluginCall call) { authorized(call, () -> { try {
        File source = owned(call.getString("path", "")); Uri tree = Uri.parse(call.getString("uri", ""));
        Uri created = exportTree(source, DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)));
        JSObject value = new JSObject(); value.put("file", created.toString()); call.resolve(value);
    } catch (Exception error) { call.reject("下载已完成，保存到所选目录失败：" + error.getMessage()); } }); }
    private void erase(File file) { if (file.isDirectory()) { File[] children = file.listFiles(); if (children != null) for (File child : children) { try { erase(owned(child.getPath())); } catch (IOException ignored) {} } } file.delete(); }
    @PluginMethod public void cleanup(PluginCall call) { authorized(call, () -> { try { erase(owned(call.getString("path", ""))); call.resolve(); } catch (Exception error) { call.reject(error.getMessage()); } }); }
    @PluginMethod public void exportText(PluginCall call) {
        String text = call.getString("text", ""); if (text.getBytes(StandardCharsets.UTF_8).length > 16 * 1024 * 1024) { call.reject("导出文本超过 16 MiB"); return; }
        choose(call, new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("text/plain").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, clean(call.getString("suggestedName", "ssh-session.txt"))), "textPicked");
    }
    @ActivityCallback private void textPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { canceled(call); return; }
        authorized(call, () -> { try {
            Uri uri = result.getData().getData();
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "w")) { output.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8)); }
            JSObject value = new JSObject(); value.put("file", uri.toString()); call.resolve(value);
        } catch (Exception error) { call.reject("导出失败：" + error.getMessage()); } });
    }
    @PluginMethod public void readClipboard(PluginCall call) { authorized(call, () -> getActivity().runOnUiThread(() -> {
        ClipboardManager manager = (ClipboardManager)getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = manager.getPrimaryClip(); String text = clip == null || clip.getItemCount() == 0 ? "" : String.valueOf(clip.getItemAt(0).coerceToText(getContext()));
        if (text.getBytes(StandardCharsets.UTF_8).length > 1024 * 1024) { call.reject("剪贴板文本超过 1 MiB"); return; }
        JSObject value = new JSObject(); value.put("text", text); call.resolve(value);
    })); }
    @PluginMethod public void writeClipboard(PluginCall call) { authorized(call, () -> getActivity().runOnUiThread(() -> {
        String text = call.getString("text", ""); if (text.getBytes(StandardCharsets.UTF_8).length > 1024 * 1024) { call.reject("文本超过 1 MiB"); return; }
        ((ClipboardManager)getContext().getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("SSH", text)); call.resolve();
    })); }
    private void canceled(PluginCall call) { JSObject value = new JSObject(); value.put("canceled", true); call.resolve(value); }
}

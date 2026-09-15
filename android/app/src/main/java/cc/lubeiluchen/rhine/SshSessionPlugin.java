package cc.lubeiluchen.rhine;

import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;
import android.Manifest;
import android.os.Build;
import com.getcapacitor.WebViewListener;
import android.webkit.WebView;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.net.InetAddress;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import org.json.JSONObject;
import android.content.Context;
import android.view.inputmethod.InputMethodManager;

@CapacitorPlugin(name = "SshSession", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class SshSessionPlugin extends RhinePlugin {
    static final class Running {
        final String id = UUID.randomUUID().toString();
        final Process process;
        volatile boolean connection;
        Running(Process process) { this.process = process; }
    }
    private final Map<String, Running> processes = SshConnectionService.processes;

    @Override public void load() {
        SshConnectionService.disconnect = () -> {
            notifyListeners("disconnectAll", new JSObject());
            stopAll();
        };
        // A WebView reload creates a new renderer but keeps the Activity. The
        // old renderer no longer owns its process, so release it here as well.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override public void onPageStarted(WebView view) { stopAll(); }
        });
    }

    @PluginMethod public void backgroundStatus(PluginCall call) {
        authorized(call, () -> { JSObject result = new JSObject(); result.put("enabled", SshConnectionService.enabled(getContext())); result.put("notificationGranted", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED); call.resolve(result); });
    }
    @PluginMethod public void background(PluginCall call) {
        authorized(call, () -> {
            if (Boolean.TRUE.equals(call.getBoolean("enabled", false)) && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
                getActivity().runOnUiThread(() -> requestPermissionForAlias("notifications", call, "notificationPermission"));
            } else applyBackground(call);
        });
    }
    @PermissionCallback private void notificationPermission(PluginCall call) { authorized(call, () -> applyBackground(call)); }
    private void applyBackground(PluginCall call) {
        boolean previous = SshConnectionService.enabled(getContext());
        try {
            boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            getContext().getSharedPreferences("ssh_background", 0).edit().putBoolean("enabled", enabled).commit();
            SshConnectionService.update(getContext());
            JSObject result = new JSObject(); result.put("enabled", enabled); result.put("notificationGranted", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED); call.resolve(result);
        } catch (Exception error) { getContext().getSharedPreferences("ssh_background", 0).edit().putBoolean("enabled", previous).apply(); call.reject("后台服务无法启动：" + error.getMessage()); }
    }
    private void updateForeground() {
        try { SshConnectionService.update(getContext()); }
        catch (Exception error) { JSObject event = new JSObject(); event.put("message", "后台服务无法启动，请回到应用后重新开启：" + error.getMessage()); notifyListeners("backgroundError", event); }
    }

    @PluginMethod public void keyboard(PluginCall call) {
        authorized(call, () -> getActivity().runOnUiThread(() -> {
            getBridge().getWebView().requestFocus();
            InputMethodManager input = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            input.showSoftInput(getBridge().getWebView(), InputMethodManager.SHOW_IMPLICIT);
            call.resolve();
        }));
    }

    @PluginMethod public void resolve(PluginCall call) {
        authorized(call, () -> {
            String host = call.getString("host", "");
            if (host.isEmpty() || host.length() > 253) { call.reject("主机地址无效"); return; }
            try {
                JSArray addresses = new JSArray();
                for (InetAddress address : InetAddress.getAllByName(host)) addresses.put(address.getHostAddress());
                JSObject result = new JSObject(); result.put("addresses", addresses); call.resolve(result);
            } catch (IOException error) { call.reject("无法解析主机地址：" + host); }
        });
    }

    @PluginMethod public void start(PluginCall call) {
        authorized(call, () -> {
            if (processes.size() >= 12) { call.reject("最多同时运行 12 个 SSH 会话，请先结束一个会话"); return; }
            File executable = new File(getContext().getApplicationInfo().nativeLibraryDir, "librhine-session.so");
            try {
                if (!executable.isFile() || !executable.canExecute()) throw new IOException("SSH agent missing or not executable for this ABI");
                ProcessBuilder builder = new ProcessBuilder(executable.getAbsolutePath());
                builder.environment().put("RHINE_SSH_RESOURCES", prepareResources().getAbsolutePath());
                Running running = new Running(builder.start());
                synchronized (this) {
                    if (disposed) { running.process.destroy(); call.reject("Application closed"); return; }
                    processes.put(running.id, running);
                }
                updateForeground();
                Thread output = new Thread(() -> pump(running), "rhine-ssh-output");
                output.setDaemon(true); output.start();
                Thread errors = new Thread(() -> {
                    try { byte[] buffer = new byte[4096]; while (running.process.getErrorStream().read(buffer) >= 0) {} }
                    catch (IOException ignored) {}
                }, "rhine-ssh-stderr");
                errors.setDaemon(true); errors.start();
                JSObject result = new JSObject();
                result.put("ok", true); result.put("id", running.id);
                result.put("abi", new File(getContext().getApplicationInfo().nativeLibraryDir).getName());
                call.resolve(result);
            } catch (IOException error) { call.reject("无法启动 SSH：" + error.getMessage()); }
        });
    }

    @PluginMethod public void send(PluginCall call) {
        authorized(call, () -> {
            Running running = processes.get(call.getString("id", ""));
            String line = call.getString("line", "");
            if (running == null || !running.id.equals(call.getString("id"))) { call.reject("会话已经改变"); return; }
            if (line.length() > 8 * 1024 * 1024 || line.indexOf('\n') >= 0 || line.indexOf('\r') >= 0) { call.reject("无效的 SSH 请求"); return; }
            try {
                if (!running.connection && "connect".equals(new JSONObject(line).optString("method"))) { running.connection = true; updateForeground(); }
                running.process.getOutputStream().write((line + "\n").getBytes(StandardCharsets.UTF_8));
                running.process.getOutputStream().flush();
                call.resolve();
            } catch (org.json.JSONException error) { call.reject("无效的 SSH 请求"); }
            catch (IOException error) { call.reject("SSH 已停止接收输入"); }
        });
    }

    @PluginMethod public void stop(PluginCall call) {
        authorized(call, () -> {
            stopProcess(call.getString("id", ""));
            call.resolve();
        });
    }

    private void pump(Running running) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(running.process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (processes.get(running.id) != running || disposed) return;
                JSObject event = new JSObject(); event.put("id", running.id); event.put("line", line);
                notifyListeners("line", event);
            }
        } catch (IOException ignored) {}
        int code = -1;
        try { code = running.process.waitFor(); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        synchronized (this) {
            if (processes.remove(running.id, running) && !disposed) {
                JSObject event = new JSObject(); event.put("id", running.id); event.put("code", code);
                notifyListeners("closed", event);
            }
        }
        updateForeground();
    }

    private synchronized void stopProcess(String id) {
        Running stopping = processes.remove(id);
        if (stopping != null) stopping.process.destroy();
        updateForeground();
    }

    private synchronized void stopAll() {
        for (String id : processes.keySet()) stopProcess(id);
        getContext().stopService(new android.content.Intent(getContext(), SshConnectionService.class));
    }

    private File prepareResources() throws IOException {
        File directory = new File(getContext().getNoBackupFilesDir(), "ssh-services");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法准备监控资源目录");
        try {
            byte[] manifest;
            try (InputStream input = getContext().getAssets().open("ssh-services/manifest.json")) { manifest = readBytes(input); }
            JSONObject files = new JSONObject(new String(manifest, StandardCharsets.UTF_8)).getJSONObject("files");
            for (String arch : new String[]{"amd64", "arm64"}) {
                JSONObject entry = files.getJSONObject("monitor/linux/" + arch);
                String name = entry.getString("name"), expected = entry.getString("sha256");
                if (!name.matches("[A-Za-z0-9_.-]+") || !expected.matches("[a-f0-9]{64}")) throw new IOException("无效采集器清单");
                File file = new File(directory, name);
                if (file.isFile()) try (InputStream input = new FileInputStream(file)) { if (digest(readBytes(input)).equals(expected)) continue; }
                byte[] content;
                try (InputStream input = getContext().getAssets().open("ssh-services/" + name)) { content = readBytes(input); }
                if (!digest(content).equals(expected)) throw new IOException("采集器校验失败");
                try (FileOutputStream output = new FileOutputStream(file)) { output.write(content); }
            }
            try (FileOutputStream output = new FileOutputStream(new File(directory, "manifest.json"))) { output.write(manifest); }
            return directory;
        } catch (Exception error) { throw new IOException("无法准备监控资源：" + error.getMessage(), error); }
    }
    private static byte[] readBytes(InputStream input) throws IOException {
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[65536]; int n;
        while ((n = input.read(buffer)) != -1) output.write(buffer, 0, n);
        return output.toByteArray();
    }
    private static String digest(byte[] bytes) throws Exception {
        StringBuilder text = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) text.append(String.format("%02x", b & 255));
        return text.toString();
    }

    @Override protected void handleOnDestroy() {
        disposed = true; stopAll(); SshConnectionService.disconnect = null; super.handleOnDestroy();
    }
}

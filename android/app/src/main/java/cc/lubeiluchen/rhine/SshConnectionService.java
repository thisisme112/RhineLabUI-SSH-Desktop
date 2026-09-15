package cc.lubeiluchen.rhine;

import android.app.Service;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.Handler;
import android.os.Looper;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Owns the native processes while the UI is in the background. A foreground
 * notification and partial wake lock keep network I/O active until disconnect.
 * A deliberate WebView reload still ends its old, unowned session protocols. */
public class SshConnectionService extends Service {
    static final Map<String, SshSessionPlugin.Running> processes = new ConcurrentHashMap<>();
    static volatile Runnable disconnect;
    static final String CHANNEL = "rhine-ssh-connections";
    static final String STOP = "cc.lubeiluchen.rhine.DISCONNECT_SSH";
    private PowerManager.WakeLock wakeLock;
    private static volatile SshConnectionService instance;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean waiting;
    private boolean stopping;
    private final Runnable idleStop = () -> { if (connectionCount() == 0) { stopForeground(true); stopSelf(); } };
    private static int connectionCount() { int count = 0; for (SshSessionPlugin.Running running : processes.values()) if (running.connection) count++; return count; }
    static boolean enabled(Context context) { return context.getSharedPreferences("ssh_background", 0).getBoolean("enabled", false); }
    static void update(Context context) {
        Intent intent = new Intent(context, SshConnectionService.class);
        if (!enabled(context)) { context.stopService(intent); return; }
        SshConnectionService service = instance;
        if (service != null) { service.handler.post(service::refresh); return; }
        if (connectionCount() == 0) return;
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
    }
    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "SSH 后台连接", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("显示正在保留的 SSH 连接，并提供返回和断开入口");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            stopping = true;
            Runnable action = disconnect;
            if (action != null) action.run();
            for (SshSessionPlugin.Running session : processes.values()) session.process.destroy();
            processes.clear(); stopForeground(true); stopSelf(); return START_NOT_STICKY;
        }
        refresh(); return START_NOT_STICKY;
    }
    private void refresh() {
        if (stopping) return;
        if (!enabled(this)) { stopForeground(true); stopSelf(); return; }
        Intent launch = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 410, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 411, new Intent(this, SshConnectionService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification notification = builder.setSmallIcon(android.R.drawable.stat_sys_upload_done).setContentTitle("Rhine Lab · SSH")
            .setContentText(connectionCount() == 0 ? "连接已结束，等待恢复" : connectionCount() + " 个连接保留在后台").setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_menu_view, "返回终端", open).addAction(android.R.drawable.ic_menu_close_clear_cancel, "全部断开", stop).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(2013, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else startForeground(2013, notification);
        // Keep the already-started service during the reconnect backoff. New
        // foreground services cannot reliably be started from the background.
        if (connectionCount() == 0) {
            if (!waiting) { waiting = true; handler.postDelayed(idleStop, 10 * 60 * 1000L); }
            return;
        }
        waiting = false; handler.removeCallbacks(idleStop);
        if (wakeLock == null) { wakeLock = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RhineLab:SSH"); wakeLock.setReferenceCounted(false); wakeLock.acquire(); }
    }
    @Override public void onTaskRemoved(Intent rootIntent) { stopping = true; Runnable action = disconnect; if (action != null) action.run(); for (SshSessionPlugin.Running session : processes.values()) session.process.destroy(); processes.clear(); stopForeground(true); stopSelf(); }
    @Override public void onDestroy() { if (instance == this) instance = null; handler.removeCallbacksAndMessages(null); if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}

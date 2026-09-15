package cc.lubeiluchen.rhine;

import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Native operations only accept the app's local document and run off the UI thread. */
public abstract class RhinePlugin extends Plugin {
    protected final ExecutorService queue = Executors.newSingleThreadExecutor();
    protected volatile boolean disposed;

    protected void authorized(PluginCall call, Runnable action) {
        getActivity().runOnUiThread(() -> {
            String address = getBridge().getWebView().getUrl();
            Uri uri = Uri.parse(address == null ? "" : address);
            if (disposed || !"https".equals(uri.getScheme()) || !"localhost".equals(uri.getHost()) || uri.getPort() != -1) {
                call.reject("Only the local Rhine Lab document may use this operation");
                return;
            }
            try { queue.execute(() -> { if (disposed) call.reject("Application closed"); else action.run(); }); }
            catch (RejectedExecutionException ignored) { call.reject("Application closed"); }
        });
    }

    @Override protected void handleOnDestroy() {
        disposed = true;
        queue.shutdownNow();
        super.handleOnDestroy();
    }
}

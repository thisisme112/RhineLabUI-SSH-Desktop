package cc.lubeiluchen.rhine;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import java.util.Locale;

public class MainActivity extends BridgeActivity {
    /** The display cutout on each side, in CSS pixels, as last told to the page. */
    private float cutoutLeft, cutoutRight;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered by hand: the SSH agent is not an npm-installed Capacitor
        // plugin, it is a Go binary this project builds and ships itself.
        registerPlugin(SshSessionPlugin.class);
        registerPlugin(SshVaultPlugin.class);
        registerPlugin(SshDocumentsPlugin.class);
        super.onCreate(savedInstanceState);

        // On its side the phone's camera is on a short edge of the window. Left to the default the system
        // keeps the window clear of it and paints that strip black; the page fills it instead and keeps its
        // own content clear (--cutout-left / --cutout-right).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            Insets cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            // Full screen, the window no longer resizes for the keyboard: the page is kept above it here.
            view.setPadding(0, 0, 0, landscape() ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0);
            float density = getResources().getDisplayMetrics().density;
            cutoutLeft = landscape() ? cutout.left / density : 0;
            cutoutRight = landscape() ? cutout.right / density : 0;
            publishCutout();
            return insets;
        });
        getBridge().addWebViewListener(new WebViewListener() {
            @Override public void onPageLoaded(WebView webView) { publishCutout(); }
        });
        applyOrientation();
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        applyOrientation();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // A dialog or the keyboard brings the bars back; a phone on its side hides them again.
        if (hasFocus) applyOrientation();
    }

    private boolean landscape() {
        return getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
    }

    /** Upright, the system bars stay outside the page. On its side the page takes the whole screen: 360 px of height has none to give them. */
    private void applyOrientation() {
        Window window = getWindow();
        boolean landscape = landscape();
        WindowCompat.setDecorFitsSystemWindows(window, !landscape);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (landscape) {
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else controller.show(WindowInsetsCompat.Type.systemBars());
        ViewCompat.requestApplyInsets(findViewById(android.R.id.content));
    }

    private void publishCutout() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        String script = String.format(Locale.ROOT,
            "document.documentElement.style.setProperty('--cutout-left','%.1fpx');document.documentElement.style.setProperty('--cutout-right','%.1fpx');",
            cutoutLeft, cutoutRight);
        getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(script, null));
    }
}

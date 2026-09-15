package cc.lubeiluchen.rhine;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered by hand: the SSH agent is not an npm-installed Capacitor
        // plugin, it is a Go binary this project builds and ships itself.
        registerPlugin(SshSessionPlugin.class);
        registerPlugin(SshVaultPlugin.class);
        registerPlugin(SshDocumentsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

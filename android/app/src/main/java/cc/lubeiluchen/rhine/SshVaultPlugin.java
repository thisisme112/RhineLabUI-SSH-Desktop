package cc.lubeiluchen.rhine;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Optional saved credentials. No plaintext fallback or export to web storage. */
@CapacitorPlugin(name = "SshVault")
public class SshVaultPlugin extends RhinePlugin {
    private static final String ALIAS = "rhine.ssh.credentials.v1";
    @PluginMethod public void available(PluginCall call) {
        authorized(call, () -> { JSObject value = new JSObject(); value.put("available", Build.VERSION.SDK_INT >= 23); call.resolve(value); });
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private String identity(PluginCall call) throws Exception {
        String value = call.getString("key", "");
        if (Build.VERSION.SDK_INT < 23 || value.isEmpty() || value.length() > 2048) throw new Exception("凭据标识无效，或设备不支持安全保存");
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(digest, Base64.NO_WRAP);
    }
    @PluginMethod public void get(PluginCall call) {
        authorized(call, () -> {
            try {
                String id = identity(call), stored = getContext().getSharedPreferences("ssh_vault", 0).getString(id, null);
                JSObject result = new JSObject();
                if (stored != null) {
                    String[] parts = stored.split(":", 2);
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                    cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
                    result.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
                }
                call.resolve(result);
            } catch (Exception error) { call.reject("无法读取已保存凭据，请重新输入或清除后保存"); }
        });
    }
    @PluginMethod public void put(PluginCall call) {
        authorized(call, () -> {
            try {
                String id = identity(call), value = call.getString("value", "");
                if (value.isEmpty() || value.length() > 512 * 1024) throw new Exception("凭据大小无效");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
                cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
                String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
                if (!getContext().getSharedPreferences("ssh_vault", 0).edit().putString(id, encrypted).commit()) throw new Exception("写入失败");
                call.resolve();
            } catch (Exception error) { call.reject("凭据未能安全保存"); }
        });
    }
    @PluginMethod public void remove(PluginCall call) {
        authorized(call, () -> {
            try {
                if (!getContext().getSharedPreferences("ssh_vault", 0).edit().remove(identity(call)).commit()) throw new Exception("写入失败");
                call.resolve();
            } catch (Exception error) { call.reject("无法清除凭据"); }
        });
    }
}

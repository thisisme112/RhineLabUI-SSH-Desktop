package native

import (
	"encoding/json"
	"errors"
	"io"
	"os"

	"golang.org/x/crypto/ssh"
)

// InspectKey reads private material only from stdin; output contains public metadata.
func InspectKey() {
	var request struct {
		Content    string `json:"content"`
		Passphrase string `json:"passphrase"`
	}
	encoder := json.NewEncoder(os.Stdout)
	fail := func(message string) { _ = encoder.Encode(map[string]any{"ok": false, "error": message}) }
	if json.NewDecoder(io.LimitReader(os.Stdin, 1024*1024)).Decode(&request) != nil {
		fail("私钥输入无效")
		return
	}
	raw, err := ssh.ParseRawPrivateKey([]byte(request.Content))
	var missing *ssh.PassphraseMissingError
	protected := errors.As(err, &missing)
	var public ssh.PublicKey
	if protected && request.Passphrase == "" {
		public = missing.PublicKey
	} else {
		if protected {
			raw, err = ssh.ParseRawPrivateKeyWithPassphrase([]byte(request.Content), []byte(request.Passphrase))
		}
		if err != nil {
			fail("私钥格式或口令不正确，请使用 OpenSSH / PEM 私钥")
			return
		}
		signer, signErr := ssh.NewSignerFromKey(raw)
		if signErr != nil {
			fail("不支持此私钥类型")
			return
		}
		public = signer.PublicKey()
	}
	kind, fingerprint := "encrypted", ""
	if public != nil {
		kind = public.Type()
		fingerprint = ssh.FingerprintSHA256(public)
	}
	_ = encoder.Encode(map[string]any{"ok": true, "type": kind, "fingerprint": fingerprint, "protected": protected})
}

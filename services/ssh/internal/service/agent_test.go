package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rhine.local/sshservices/internal/native"
)

func writeAgentManifest(t *testing.T, dir string, sha string, size int64) {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"protocol": 1, "version": "test", "files": map[string]any{
		"agent/linux/amd64": map[string]any{"name": "rhine-agent-linux-amd64", "sha256": sha, "size": size},
	}})
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAgentBinariesAreCheckedAgainstTheManifest(t *testing.T) {
	dir := t.TempDir()
	body := []byte("agent build")
	if err := os.WriteFile(filepath.Join(dir, "rhine-agent-linux-amd64"), body, 0o700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	writeAgentManifest(t, dir, hex.EncodeToString(digest[:]), int64(len(body)))
	binaries, err := agentBinaries(dir)
	if err != nil || binaries["amd64"].Size != int64(len(body)) {
		t.Fatalf("matching build accepted: %v %v", binaries, err)
	}
	writeAgentManifest(t, dir, strings.Repeat("0", 64), int64(len(body)))
	if _, err := agentBinaries(dir); err == nil {
		t.Fatal("a build that does not match its manifest is refused")
	}
}

func TestAgentTransportWithoutBuildsSaysSo(t *testing.T) {
	var events []Event
	s, err := New(Config{SessionID: "test", SSH: native.Config{Args: []string{"unused"}}, Resources: t.TempDir(), Transport: "agent"},
		func(event Event) { events = append(events, event) }, func(native.Challenge) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if len(events) != 1 || events[0].Event != "capability" {
		t.Fatalf("events %v", events)
	}
	data := events[0].Data.(map[string]any)
	if data["service"] != "transport" || data["state"] != "unsupported" {
		t.Fatalf("capability %v", data)
	}
}

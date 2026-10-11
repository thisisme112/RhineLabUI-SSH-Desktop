//go:build linux

package native

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
)

// The single-connection transport end to end on this machine: a stand-in for
// ssh runs the remote command locally (as sshd would, through a shell) and
// writes one line per login, so the test can count logins.

func buildAgent(t *testing.T) AgentBinary {
	t.Helper()
	out := filepath.Join(t.TempDir(), "rhine-agent")
	cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", out, "./cmd/agent")
	cmd.Dir = filepath.Join("..", "..")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build agent: %v\n%s", err, output)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return AgentBinary{Path: out, SHA256: hex.EncodeToString(digest[:]), Size: int64(len(data))}
}

type fakeServer struct {
	config Config
	log    string
	home   string
}

func newFakeServer(t *testing.T) fakeServer {
	t.Helper()
	dir := t.TempDir()
	ssh := filepath.Join(dir, "ssh")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RHINE_FAKE_SSH_LOG\"\nfor last; do :; done\nexec /bin/sh -c \"$last\"\n"
	if err := os.WriteFile(ssh, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	log := filepath.Join(dir, "logins")
	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("RHINE_FAKE_SSH_LOG", log)
	t.Setenv("RHINE_AGENT_IDLE_SECONDS", "3")
	return fakeServer{config: Config{Executable: ssh, Args: []string{"-T", "fixture-host"}}, log: log, home: home}
}

func (f fakeServer) logins(t *testing.T) int {
	t.Helper()
	data, err := os.ReadFile(f.log)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(data), "\n")
}

type statusLog struct {
	mu    sync.Mutex
	lines []string
}

func (s *statusLog) add(state, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lines = append(s.lines, state+" "+message)
}
func (s *statusLog) contains(text string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, line := range s.lines {
		if strings.Contains(line, text) {
			return true
		}
	}
	return false
}

func newAgentBroker(t *testing.T, binary AgentBinary, status *statusLog) *Broker {
	t.Helper()
	broker, err := NewBroker(func(Challenge) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	broker.UseAgent(map[string]AgentBinary{runtime.GOARCH: binary}, status.add)
	return broker
}

func echoServer(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	return listener.Addr().String()
}

func TestAgentCarriesEveryServiceOnOneLogin(t *testing.T) {
	binary := buildAgent(t)
	server := newFakeServer(t)
	status := &statusLog{}
	broker := newAgentBroker(t, binary, status)
	ctx := context.Background()

	// Files: an SFTP channel, served by the agent in its user's home.
	files, err := broker.Start(ctx, server.config, "sftp", "sftp", true)
	if err != nil {
		t.Fatal(err)
	}
	client, err := sftp.NewClientPipe(files.Stdout, files.Stdin)
	if err != nil {
		t.Fatal(err)
	}
	if where, err := client.RealPath("."); err != nil || where != server.home {
		t.Fatalf("SFTP home %q, got %q (%v)", server.home, where, err)
	}
	// The monitor's probe: an exec channel.
	output, err := broker.Run(ctx, server.config, "monitor", "sh -c 'uname -s'")
	if err != nil || strings.TrimSpace(string(output)) != "Linux" {
		t.Fatalf("probe %q %v", output, err)
	}
	// Three connections through a forward: three channels, no login each.
	address := echoServer(t)
	for i := 0; i < 3; i++ {
		conn, err := broker.OpenForward(ctx, server.config, address)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = conn.Write([]byte("rhine"))
		reply := make([]byte, 5)
		if _, err := io.ReadFull(conn, reply); err != nil || string(reply) != "rhine" {
			t.Fatalf("forward echo %q %v", reply, err)
		}
		_ = conn.Close()
	}
	if got := server.logins(t); got != 1 {
		t.Fatalf("one login for files, monitor and forwards, got %d", got)
	}
	if !status.contains("正在上传服务端程序") || !status.contains("ready") {
		t.Fatalf("status %v", status.lines)
	}
	cached := filepath.Join(server.home, ".cache/rhine-lab/agent", runtime.GOARCH+"-"+binary.SHA256[:16], "agent")
	if _, err := os.Stat(cached); err != nil {
		t.Fatalf("agent left in the cache: %v", err)
	}
	_ = client.Close()
	files.Close()
	broker.Close()

	// The next session finds the build and the resident process: one more login, no upload.
	again := &statusLog{}
	second := newAgentBroker(t, binary, again)
	defer second.Close()
	output, err = second.Run(ctx, server.config, "monitor", "echo again")
	if err != nil || strings.TrimSpace(string(output)) != "again" {
		t.Fatalf("second session %q %v", output, err)
	}
	if got := server.logins(t); got != 2 {
		t.Fatalf("one login per session, got %d", got)
	}
	if again.contains("正在上传") {
		t.Fatal("the cached build is not uploaded again")
	}
	log, _ := os.ReadFile(filepath.Join(filepath.Dir(cached), "agent.log"))
	if strings.Count(string(log), "started pid") != 1 {
		t.Fatalf("the resident process is reused, log:\n%s", log)
	}
}

func TestAgentUnsupportedServerFallsBackOnce(t *testing.T) {
	binary := buildAgent(t)
	server := newFakeServer(t)
	fake := t.TempDir()
	if err := os.WriteFile(filepath.Join(fake, "uname"), []byte("#!/bin/sh\necho Darwin\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fake+":"+os.Getenv("PATH"))
	status := &statusLog{}
	broker := newAgentBroker(t, binary, status)
	defer broker.Close()
	for i := 0; i < 2; i++ {
		output, err := broker.Run(context.Background(), server.config, "monitor", "echo fallback")
		if err != nil || strings.TrimSpace(string(output)) != "fallback" {
			t.Fatalf("fallback %q %v", output, err)
		}
	}
	// The bootstrap once, then one login per service as before (and no second bootstrap).
	if got := server.logins(t); got != 3 {
		t.Fatalf("logins %d", got)
	}
	if !status.contains("unsupported") {
		t.Fatalf("status %v", status.lines)
	}
}

func TestAgentReconnectWaitsOutTheRetryDelay(t *testing.T) {
	binary := buildAgent(t)
	server := newFakeServer(t)
	previous := agentRetryDelay
	agentRetryDelay = 500 * time.Millisecond
	t.Cleanup(func() { agentRetryDelay = previous })
	broker := newAgentBroker(t, binary, &statusLog{})
	defer broker.Close()
	ctx := context.Background()
	if _, err := broker.Run(ctx, server.config, "monitor", "true"); err != nil {
		t.Fatal(err)
	}
	// The login drops.
	broker.agent.mu.Lock()
	client := broker.agent.client
	broker.agent.mu.Unlock()
	_ = client.Close()
	for i := 0; i < 50; i++ {
		broker.agent.mu.Lock()
		gone := broker.agent.client == nil
		broker.agent.mu.Unlock()
		if gone {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := broker.Run(ctx, server.config, "monitor", "true"); err == nil || !strings.Contains(err.Error(), "秒后再试") {
		t.Fatalf("an immediate request waits out the delay, got %v", err)
	}
	time.Sleep(600 * time.Millisecond)
	if _, err := broker.Run(ctx, server.config, "monitor", "true"); err != nil {
		t.Fatal(err)
	}
	if got := server.logins(t); got != 2 {
		t.Fatalf("logins %d", got)
	}
}

// writeSSH replaces the stand-in for ssh with another script body (after the login is logged).
func (f fakeServer) writeSSH(t *testing.T, body string) {
	t.Helper()
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RHINE_FAKE_SSH_LOG\"\n" + body
	if err := os.WriteFile(f.config.Executable, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestAgentRestrictedAccountFallsBack(t *testing.T) {
	binary := buildAgent(t)
	server := newFakeServer(t)
	// A login that runs anything it is given as a fixed command (git-shell, ForceCommand, the Go fixture).
	server.writeSSH(t, "echo restricted-shell-output\nexit 0\n")
	status := &statusLog{}
	broker := newAgentBroker(t, binary, status)
	defer broker.Close()
	output, err := broker.Run(context.Background(), server.config, "monitor", "anything")
	if err != nil || strings.TrimSpace(string(output)) != "restricted-shell-output" {
		t.Fatalf("falls back to the login per service: %q %v", output, err)
	}
	if !status.contains("unsupported") {
		t.Fatalf("status %v", status.lines)
	}
}

func TestAgentRefusedLoginIsNotRetriedPerService(t *testing.T) {
	binary := buildAgent(t)
	server := newFakeServer(t)
	// ssh's own failure: refused or banned.
	server.writeSSH(t, "echo 'kex_exchange_identification: Connection closed by remote host' >&2\nexit 255\n")
	broker := newAgentBroker(t, binary, &statusLog{})
	defer broker.Close()
	for i := 0; i < 3; i++ {
		if _, err := broker.Run(context.Background(), server.config, "monitor", "true"); err == nil {
			t.Fatal("a refused login is reported")
		}
	}
	// One attempt; the retries inside the delay make no login at all, and nothing falls back to more logins.
	if got := server.logins(t); got != 1 {
		t.Fatalf("logins %d", got)
	}
}

package native

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// The desktop's single-connection transport.
//
// Without it every service is its own OpenSSH login: SFTP, the monitor probe,
// the monitor collector, and one per TCP connection through a forward. Four or
// more logins in a few seconds is what a server's brute-force guard refuses.
//
// With it, the services make one OpenSSH login per session. That login runs a
// bootstrap script which leaves the remote agent (cmd/agent) in the user's
// cache, uploading it over the same login only when the right build is not
// already there, and then becomes `agent attach`. From that point the login's
// stdio carries an SSH connection to the agent, and every service is a channel
// of it (startAuthenticated, OpenForward), as on Android. Losing the login is
// survivable: the next request reconnects, but not sooner than agentRetryDelay
// after the last attempt, so a broken network cannot become a login storm.

// ErrAgentUnsupported means the server cannot run the agent (not Linux, an
// unknown architecture, no sha256 tool, a cache that cannot execute); only then
// do the services fall back to a login each.
var ErrAgentUnsupported = errors.New("服务器无法运行 Rhine 服务端程序")

// AgentBinary is one Linux build of cmd/agent the desktop ships, checked against its manifest.
type AgentBinary struct {
	Path   string
	SHA256 string
	Size   int64
}

const (
	agentBootstrapLimit = 5 * time.Minute
	agentKeepAlive      = 30 * time.Second
)

// agentRetryDelay is the least time between two connection attempts (a variable for the tests).
var agentRetryDelay = 20 * time.Second

type agentTransport struct {
	broker   *Broker
	binaries map[string]AgentBinary
	status   func(state, message string)

	mu          sync.Mutex
	client      *ssh.Client
	process     *Connection
	connecting  chan struct{}
	failure     error
	failedAt    time.Time
	unsupported error
}

// UseAgent makes the desktop broker reach the server through the remote agent
// (binaries by GOARCH: "amd64", "arm64"). status hears connecting / ready /
// error / unsupported with a message for the user.
func (b *Broker) UseAgent(binaries map[string]AgentBinary, status func(state, message string)) {
	if status == nil {
		status = func(string, string) {}
	}
	b.agent = &agentTransport{broker: b, binaries: binaries, status: status}
}

// dial returns the live connection to the agent, making it if there is none.
// Concurrent callers share one attempt.
func (a *agentTransport) dial(ctx context.Context, config Config) (*ssh.Client, error) {
	for {
		a.mu.Lock()
		if a.unsupported != nil {
			err := a.unsupported
			a.mu.Unlock()
			return nil, err
		}
		if a.client != nil {
			client := a.client
			a.mu.Unlock()
			return client, nil
		}
		if wait := a.connecting; wait != nil {
			a.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if a.failure != nil && time.Since(a.failedAt) < agentRetryDelay {
			left := int((agentRetryDelay - time.Since(a.failedAt)).Seconds()) + 1
			err := fmt.Errorf("服务通道不可用，%d 秒后再试（避免触发服务器的登录频率限制）：%v", left, a.failure)
			a.mu.Unlock()
			return nil, err
		}
		if a.broker.ctx.Err() != nil {
			a.mu.Unlock()
			return nil, errors.New("会话已结束")
		}
		done := make(chan struct{})
		a.connecting = done
		a.mu.Unlock()

		client, process, err := a.connect(config)

		a.mu.Lock()
		a.connecting = nil
		close(done)
		if err != nil {
			if errors.Is(err, ErrAgentUnsupported) {
				a.unsupported = err
				a.mu.Unlock()
				a.status("unsupported", err.Error()+"；改为每项服务单独登录")
				return nil, err
			}
			a.failure, a.failedAt = err, time.Now()
			a.mu.Unlock()
			a.status("error", err.Error())
			return nil, err
		}
		a.client, a.process, a.failure = client, process, nil
		a.mu.Unlock()
		a.status("ready", "服务通道已建立：文件、监控与转发共用一次登录")
		go a.watch(client, process)
		return client, nil
	}
}

func (a *agentTransport) connect(config Config) (*ssh.Client, *Connection, error) {
	nonce := RandomID()[:12]
	a.status("connecting", "正在建立服务通道")
	// The transport outlives the request that asked for it: it lives as long as the broker.
	process, err := a.broker.startOpenSSH(a.broker.ctx, config, "agent", "sh -c "+Quote(agentBootstrap(nonce, a.binaries)), false)
	if err != nil {
		return nil, nil, err
	}
	limit := time.AfterFunc(agentBootstrapLimit, process.Close)
	defer limit.Stop()
	reader := bufio.NewReaderSize(process.Stdout, 64*1024)
	marker := "RHINE_AGENT_" + nonce + " "
	fail := func(err error) (*ssh.Client, *Connection, error) {
		process.Close()
		return nil, nil, err
	}
	answered := false
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			select {
			case <-process.done:
			case <-time.After(2 * time.Second):
			}
			process.Close()
			<-process.done
			process.mu.Lock()
			waitErr := process.err
			process.mu.Unlock()
			// ssh exits 255 when it could not log in at all (refused, banned, wrong credentials): that is an
			// error, never a reason to try a login per service. A login that ran to its end without ever
			// answering ran somewhere the script cannot (an SFTP-only account, a restricted shell).
			var exit *exec.ExitError
			if !answered && (waitErr == nil || (errors.As(waitErr, &exit) && exit.ExitCode() != 255 && exit.ExitCode() >= 0)) {
				return nil, nil, fmt.Errorf("%w（远端没有运行引导脚本，可能是仅限 SFTP 或受限 shell 的账户）", ErrAgentUnsupported)
			}
			if failure := process.Error(); failure != nil {
				return nil, nil, failure
			}
			return nil, nil, fmt.Errorf("服务通道在准备时断开：%v", readErr)
		}
		// Whatever the login shell's startup files print comes before the marker and is skipped.
		line = strings.TrimRight(line, "\r\n")
		if !strings.HasPrefix(line, marker) {
			continue
		}
		answered = true
		fields := strings.Fields(strings.TrimPrefix(line, marker))
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "unsupported":
			return fail(fmt.Errorf("%w（%s）", ErrAgentUnsupported, strings.Join(fields[1:], " ")))
		case "send":
			arch := ""
			if len(fields) > 1 {
				arch = fields[1]
			}
			binary, ok := a.binaries[arch]
			if !ok {
				return fail(fmt.Errorf("%w（缺少 linux/%s 服务端程序）", ErrAgentUnsupported, arch))
			}
			a.status("connecting", fmt.Sprintf("正在上传服务端程序（linux/%s，%.1f MiB，同一版本只传一次）", arch, float64(binary.Size)/(1<<20)))
			if err := sendAgent(process.Stdin, binary); err != nil {
				return fail(fmt.Errorf("上传服务端程序失败：%w", err))
			}
		case "failed", "bad":
			return fail(fmt.Errorf("服务器上的服务端程序准备失败：%s", strings.Join(fields, " ")))
		case "ready":
			limit.Stop()
			client, err := agentHandshake(reader, process)
			if err != nil {
				return fail(err)
			}
			return client, process, nil
		}
	}
}

func sendAgent(w io.Writer, binary AgentBinary) error {
	file, err := os.Open(binary.Path)
	if err != nil {
		return err
	}
	defer file.Close()
	written, err := io.Copy(w, io.LimitReader(file, binary.Size))
	if err == nil && written != binary.Size {
		err = fmt.Errorf("只发送了 %d / %d 字节", written, binary.Size)
	}
	return err
}

func agentHandshake(reader io.Reader, process *Connection) (*ssh.Client, error) {
	conn := &agentConn{reader: reader, writer: process.Stdin, closer: process.Close}
	limit := time.AfterFunc(30*time.Second, process.Close)
	defer limit.Stop()
	inner, channels, requests, err := ssh.NewClientConn(conn, "rhine-agent", &ssh.ClientConfig{
		User: "rhine",
		// The outer OpenSSH login verified the server and authenticated the user; the bootstrap
		// checked the agent it runs by SHA-256. The inner key is per process and identifies nothing more.
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	})
	if err != nil {
		return nil, fmt.Errorf("服务端程序握手失败：%w", err)
	}
	return ssh.NewClient(inner, channels, requests), nil
}

// watch keeps the connection checked and forgets it when it ends.
func (a *agentTransport) watch(client *ssh.Client, process *Connection) {
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(agentKeepAlive)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
			reply := make(chan error, 1)
			go func() { _, _, err := client.SendRequest("keepalive@rhine-lab", true, nil); reply <- err }()
			select {
			case err := <-reply:
				if err != nil {
					_ = client.Close()
					return
				}
			case <-time.After(20 * time.Second):
				_ = client.Close()
				return
			case <-stop:
				return
			}
		}
	}()
	err := client.Wait()
	close(stop)
	process.Close()
	a.mu.Lock()
	current := a.client == client
	if current {
		a.client, a.process = nil, nil
		if a.broker.ctx.Err() == nil {
			reason := "连接中断"
			if err != nil {
				reason = err.Error()
			}
			a.failure, a.failedAt = fmt.Errorf("服务通道已断开：%s", reason), time.Now()
		}
	}
	ended := a.broker.ctx.Err() != nil
	a.mu.Unlock()
	if current && !ended {
		a.status("error", "服务通道已断开；下次操作时自动重连")
	}
}

func (a *agentTransport) close() {
	a.mu.Lock()
	client, process := a.client, a.process
	a.client, a.process = nil, nil
	a.mu.Unlock()
	if client != nil {
		_ = client.Close()
	}
	if process != nil {
		process.Close()
	}
}

type agentConn struct {
	reader io.Reader
	writer io.Writer
	closer func()
}

func (c *agentConn) Read(p []byte) (int, error)       { return c.reader.Read(p) }
func (c *agentConn) Write(p []byte) (int, error)      { return c.writer.Write(p) }
func (c *agentConn) Close() error                     { c.closer(); return nil }
func (c *agentConn) LocalAddr() net.Addr              { return agentAddr{} }
func (c *agentConn) RemoteAddr() net.Addr             { return agentAddr{} }
func (c *agentConn) SetDeadline(time.Time) error      { return nil }
func (c *agentConn) SetReadDeadline(time.Time) error  { return nil }
func (c *agentConn) SetWriteDeadline(time.Time) error { return nil }

type agentAddr struct{}

func (agentAddr) Network() string { return "rhine-agent" }
func (agentAddr) String() string  { return "rhine-agent" }

// agentBootstrap is one line of POSIX sh, so the login shell (bash, zsh, fish,
// csh) only has to pass a single-quoted string to sh: no newline, no "!".
// It answers with marker lines and finally becomes the agent:
//
//	unsupported <why>   not Linux / unknown architecture / no sha256 tool / cannot execute
//	send <arch>         the right build is missing: the next <size> bytes on stdin are it
//	bad | failed <why>  the upload did not check out or could not be installed
//	ready               the agent runs; stdin and stdout now carry its SSH connection
func agentBootstrap(nonce string, binaries map[string]AgentBinary) string {
	value := func(arch string) (string, string) {
		binary, ok := binaries[arch]
		if !ok {
			return "", "0"
		}
		return binary.SHA256, strconv.FormatInt(binary.Size, 10)
	}
	amdSHA, amdSize := value("amd64")
	armSHA, armSize := value("arm64")
	return strings.NewReplacer("@N@", nonce, "@SA@", amdSHA, "@ZA@", amdSize, "@SB@", armSHA, "@ZB@", armSize).Replace(strings.Join([]string{
		`n=@N@;`,
		`say() { printf 'RHINE_AGENT_%s %s\n' "$n" "$*"; };`,
		`o=$(uname -s 2>/dev/null);`,
		`if [ "$o" = Linux ]; then :; else say unsupported "$o"; exit 0; fi;`,
		`case $(uname -m 2>/dev/null) in x86_64|amd64) a=amd64 s=@SA@ z=@ZA@;; aarch64|arm64) a=arm64 s=@SB@ z=@ZB@;; *) say unsupported "$(uname -m 2>/dev/null)"; exit 0;; esac;`,
		`if [ -n "$s" ]; then :; else say unsupported "no-$a-build"; exit 0; fi;`,
		`if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }; elif command -v openssl >/dev/null 2>&1; then sum() { openssl dgst -sha256 -r "$1" | cut -d' ' -f1; }; else say unsupported no-sha256; exit 0; fi;`,
		`umask 077;`,
		`d=${XDG_CACHE_HOME:-$HOME/.cache}/rhine-lab/agent/$a-$(printf %s "$s" | cut -c1-16); f=$d/agent;`,
		`if [ -x "$f" ] && [ "$(sum "$f")" = "$s" ]; then :; else`,
		`mkdir -p "$d" || { say failed mkdir; exit 1; };`,
		`t=$f.$$; say send "$a";`,
		`head -c "$z" > "$t" || { rm -f "$t"; say failed write; exit 1; };`,
		`if [ "$(sum "$t")" = "$s" ]; then :; else rm -f "$t"; say bad checksum; exit 1; fi;`,
		`chmod 700 "$t" && mv -f "$t" "$f" || { rm -f "$t"; say failed install; exit 1; };`,
		`fi;`,
		`if "$f" --version >/dev/null 2>&1; then :; else say unsupported cannot-execute; exit 0; fi;`,
		`say ready; exec "$f" attach`,
	}, " "))
}

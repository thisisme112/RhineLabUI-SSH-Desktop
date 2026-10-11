//go:build linux

// Command agent is the resident half of the desktop's single-connection mode
// (internal/agent). The desktop's bootstrap script leaves it in
// ~/.cache/rhine-lab/agent/<arch>-<sha256 prefix>/agent and runs `agent attach`
// over its one OpenSSH login.
//
//	attach   reach the resident daemon of this user and version, starting it
//	         when it is not running, and relay this login's stdio to it; if no
//	         daemon can run, serve this one stream here instead
//	daemon   the resident process: a unix socket only this user can reach, one
//	         SSH server per attached stream, gone after a quiet spell
//	stdio    serve the SSH server on stdin/stdout without a daemon
//
// One daemon per user and version: an exclusive lock on agent.lock in the
// version's directory decides it. The directory is 0700 and the socket 0600,
// and a connection from another uid is closed unread (SO_PEERCRED).
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"rhine.local/sshservices/internal/agent"
)

func main() {
	mode := "attach"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	switch mode {
	case "--version", "version":
		fmt.Println(agent.Version)
	case "attach":
		os.Exit(attach())
	case "daemon":
		os.Exit(daemon())
	case "stdio":
		os.Exit(serveStdio())
	default:
		fmt.Fprintln(os.Stderr, "usage: agent [attach|daemon|stdio|--version]")
		os.Exit(2)
	}
}

func directory() string {
	executable, err := os.Executable()
	if err != nil {
		return "."
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	return filepath.Dir(executable)
}

// socketPath is next to the binary, unless that path is too long for a unix
// socket (108 bytes); then a 0700 directory of this user under the system temp.
func socketPath() (string, error) {
	dir := directory()
	path := filepath.Join(dir, "agent.sock")
	if len(path) < 100 {
		return path, nil
	}
	digest := sha256.Sum256([]byte(dir))
	short := filepath.Join(os.TempDir(), "rhine-agent-"+strconv.Itoa(os.Getuid()))
	if err := os.MkdirAll(short, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(short)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || int(stat.Uid) != os.Getuid() || info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("%s is not a private directory of this user", short)
	}
	return filepath.Join(short, hex.EncodeToString(digest[:8])+".sock"), nil
}

func home() string {
	if value, err := os.UserHomeDir(); err == nil && value != "" {
		return value
	}
	return "/"
}

func attach() int {
	path, err := socketPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, "rhine-agent:", err)
		return serveStdio()
	}
	conn, err := net.Dial("unix", path)
	if err != nil {
		// Not running (or a stale socket): start it, then wait for it to listen.
		if startErr := startDaemon(); startErr != nil {
			fmt.Fprintln(os.Stderr, "rhine-agent: cannot start the resident process:", startErr)
		}
		for i := 0; i < 50 && err != nil; i++ {
			time.Sleep(100 * time.Millisecond)
			conn, err = net.Dial("unix", path)
		}
	}
	if err != nil {
		// The stream is still served, only without a resident process behind it.
		fmt.Fprintln(os.Stderr, "rhine-agent: serving without the resident process:", err)
		return serveStdio()
	}
	unixConn := conn.(*net.UnixConn)
	go func() {
		_, _ = io.Copy(unixConn, os.Stdin)
		_ = unixConn.CloseWrite()
	}()
	_, _ = io.Copy(os.Stdout, unixConn)
	_ = unixConn.Close()
	return 0
}

func startDaemon() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	cmd := exec.Command(executable, "daemon")
	cmd.Dir = home()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	// Its own session: the login that started it may end, the daemon stays.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func idleLimit() time.Duration {
	if value, err := strconv.Atoi(os.Getenv("RHINE_AGENT_IDLE_SECONDS")); err == nil && value > 0 {
		return time.Duration(value) * time.Second
	}
	return 30 * time.Minute
}

func daemon() int {
	dir := directory()
	logFile := openLog(filepath.Join(dir, "agent.log"))
	if logFile != nil {
		defer logFile.Close()
		log.SetOutput(logFile)
	}
	lock, err := os.OpenFile(filepath.Join(dir, "agent.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		log.Println("lock:", err)
		return 1
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		// Another daemon of this version is already serving.
		return 0
	}
	path, err := socketPath()
	if err != nil {
		log.Println("socket:", err)
		return 1
	}
	_ = os.Remove(path)
	old := unix.Umask(0o077)
	listener, err := net.Listen("unix", path)
	unix.Umask(old)
	if err != nil {
		log.Println("listen:", err)
		return 1
	}
	defer os.Remove(path)
	_ = os.Chmod(path, 0o600)
	signer, err := agent.NewSigner()
	if err != nil {
		log.Println("host key:", err)
		return 1
	}
	config := agent.ServerConfig(signer)
	root := home()
	_ = os.Chdir(root)
	log.Printf("started pid %d, %s", os.Getpid(), agent.Version)

	var mu sync.Mutex
	active := 0
	limit := idleLimit()
	idle := time.AfterFunc(limit, func() { _ = listener.Close() })
	for {
		conn, err := listener.Accept()
		if err != nil {
			break
		}
		if !sameUser(conn) {
			_ = conn.Close()
			continue
		}
		mu.Lock()
		active++
		idle.Stop()
		mu.Unlock()
		go func() {
			if err := agent.Serve(conn, config, root); err != nil {
				log.Println("stream:", err)
			}
			mu.Lock()
			active--
			if active == 0 {
				idle.Reset(limit)
			}
			mu.Unlock()
		}()
	}
	log.Printf("idle for %s, exiting", limit)
	return 0
}

func sameUser(conn net.Conn) bool {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return false
	}
	var credentials *unix.Ucred
	var credentialErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, credentialErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil || credentialErr != nil || credentials == nil {
		return false
	}
	return int(credentials.Uid) == os.Getuid()
}

// openLog appends to the daemon's log, starting it over past 1 MiB.
func openLog(path string) *os.File {
	if info, err := os.Stat(path); err == nil && info.Size() > 1<<20 {
		_ = os.Remove(path)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	return file
}

type stdioConn struct{}

func (stdioConn) Read(p []byte) (int, error)       { return os.Stdin.Read(p) }
func (stdioConn) Write(p []byte) (int, error)      { return os.Stdout.Write(p) }
func (stdioConn) Close() error                     { _ = os.Stdin.Close(); return os.Stdout.Close() }
func (stdioConn) LocalAddr() net.Addr              { return stdioAddr{} }
func (stdioConn) RemoteAddr() net.Addr             { return stdioAddr{} }
func (stdioConn) SetDeadline(time.Time) error      { return nil }
func (stdioConn) SetReadDeadline(time.Time) error  { return nil }
func (stdioConn) SetWriteDeadline(time.Time) error { return nil }

type stdioAddr struct{}

func (stdioAddr) Network() string { return "stdio" }
func (stdioAddr) String() string  { return "stdio" }

func serveStdio() int {
	signer, err := agent.NewSigner()
	if err != nil {
		fmt.Fprintln(os.Stderr, "rhine-agent:", err)
		return 1
	}
	root := home()
	_ = os.Chdir(root)
	if err := agent.Serve(stdioConn{}, agent.ServerConfig(signer), root); err != nil {
		fmt.Fprintln(os.Stderr, "rhine-agent:", err)
		return 1
	}
	return 0
}

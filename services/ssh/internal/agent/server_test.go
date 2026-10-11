//go:build !windows

package agent

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// connect serves the agent on one end of a pipe and returns a client on the other, as the desktop holds it.
func connect(t *testing.T, home string) *ssh.Client {
	t.Helper()
	signer, err := NewSigner()
	if err != nil {
		t.Fatal(err)
	}
	// A real (buffered) socket: both ends send their version line at once, which net.Pipe would deadlock on.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = Serve(server, ServerConfig(signer), home) }()
	conn, channels, requests, err := ssh.NewClientConn(client, "agent", &ssh.ClientConfig{User: "rhine", HostKeyCallback: ssh.InsecureIgnoreHostKey()})
	if err != nil {
		t.Fatal(err)
	}
	c := ssh.NewClient(conn, channels, requests)
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestSFTPIsRootedAtHome(t *testing.T) {
	home := t.TempDir()
	client := connect(t, home)
	files, err := sftp.NewClient(client)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	where, err := files.RealPath(".")
	if err != nil || where != home {
		t.Fatalf("home %q, got %q (%v)", home, where, err)
	}
	file, err := files.Create("note.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("rhine"))
	_ = file.Close()
	if _, ok := files.HasExtension("posix-rename@openssh.com"); !ok {
		t.Fatal("posix-rename is advertised")
	}
	if err := files.PosixRename("note.txt", "kept.txt"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(home, "kept.txt"))
	if err != nil || string(data) != "rhine" {
		t.Fatalf("file on disk: %q %v", data, err)
	}
	entries, err := files.ReadDir(".")
	if err != nil || len(entries) != 1 || entries[0].Name() != "kept.txt" {
		t.Fatalf("listing: %v %v", entries, err)
	}
}

func TestExecRunsInHomeWithStdinAndExitStatus(t *testing.T) {
	home := t.TempDir()
	client := connect(t, home)
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	session.Stdin = strings.NewReader("from the desktop")
	var out bytes.Buffer
	session.Stdout = &out
	err = session.Run("pwd; cat; exit 3")
	var exit *ssh.ExitError
	if !errors.As(err, &exit) || exit.ExitStatus() != 3 {
		t.Fatalf("exit status 3, got %v", err)
	}
	if got := out.String(); got != home+"\nfrom the desktop" {
		t.Fatalf("output %q", got)
	}
}

func TestClosingTheChannelEndsTheCommand(t *testing.T) {
	client := connect(t, t.TempDir())
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Start("sleep 30; echo late"); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- session.Wait() }()
	time.Sleep(200 * time.Millisecond)
	_ = session.Close()
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("the command outlived its channel")
	}
}

func TestDirectTCPIPDialsFromTheServer(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	client := connect(t, t.TempDir())
	conn, err := client.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("echo through the agent")); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 64)
	n, err := io.ReadAtLeast(conn, buffer, len("echo through the agent"))
	if err != nil || string(buffer[:n]) != "echo through the agent" {
		t.Fatalf("echo %q %v", buffer[:n], err)
	}
	if _, err := client.Dial("tcp", "127.0.0.1:1"); err == nil {
		t.Fatal("a refused target is reported, not accepted")
	}
}

// Package agent is the Rhine remote agent's SSH server.
//
// The desktop used to open a separate OpenSSH login for every service: the
// SFTP channel, the monitor probe, the monitor collector, and one per TCP
// connection through a port forward. A server that limits new connections
// (sshd MaxStartups, ufw limit, fail2ban, a cloud provider's brute-force
// guard) refused or banned the client after a few seconds of normal use.
//
// The agent is a small resident program left on the server, like the server
// half of an editor's remote mode. The desktop makes one OpenSSH login, starts
// (or reaches) the agent over it, and speaks SSH to the agent through that
// login's stdio. Every service is then a channel of that inner connection:
// the outer OpenSSH login already authenticated and encrypted the stream, so
// the inner one takes no credentials and only multiplexes.
//
// Served here, per attached stream:
//
//	session  subsystem "sftp"  pkg/sftp's server, in process, rooted at $HOME
//	session  exec <command>    /bin/sh -c <command> with the agent's environment
//	direct-tcpip               a TCP connection dialled from the server
//
// Nothing listens on the network: the agent is reached through the login that
// started it (cmd/agent).
package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// Version is the agent protocol the desktop expects; `agent --version` prints it.
const Version = "rhine-agent 1 protocol=1"

// NewSigner returns a host key for one agent process. It is never persisted:
// the inner connection's identity is the outer login that started the agent.
func NewSigner() (ssh.Signer, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(key)
}

// ServerConfig accepts the inner client without credentials; see the package comment.
func ServerConfig(signer ssh.Signer) *ssh.ServerConfig {
	config := &ssh.ServerConfig{NoClientAuth: true, ServerVersion: "SSH-2.0-RhineAgent_1"}
	config.AddHostKey(signer)
	return config
}

// Serve runs the SSH server on one attached stream until it ends.
func Serve(conn net.Conn, config *ssh.ServerConfig, home string) error {
	defer conn.Close()
	server, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return err
	}
	defer server.Close()
	go ssh.DiscardRequests(requests)
	var work sync.WaitGroup
	for incoming := range channels {
		switch incoming.ChannelType() {
		case "session":
			work.Add(1)
			go func() { defer work.Done(); session(incoming, home) }()
		case "direct-tcpip":
			work.Add(1)
			go func() { defer work.Done(); direct(incoming) }()
		default:
			_ = incoming.Reject(ssh.UnknownChannelType, "unsupported channel type")
		}
	}
	work.Wait()
	return nil
}

func session(incoming ssh.NewChannel, home string) {
	channel, requests, err := incoming.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var env []string
	started := false
	finished := make(chan struct{})
	for request := range requests {
		switch {
		case request.Type == "env" && !started:
			var pair struct{ Name, Value string }
			if ssh.Unmarshal(request.Payload, &pair) == nil && pair.Name != "" {
				env = append(env, pair.Name+"="+pair.Value)
			}
			_ = request.Reply(true, nil)
		case request.Type == "subsystem" && !started:
			var subsystem struct{ Name string }
			if ssh.Unmarshal(request.Payload, &subsystem) != nil || subsystem.Name != "sftp" {
				_ = request.Reply(false, nil)
				continue
			}
			started = true
			_ = request.Reply(true, nil)
			go func() { defer close(finished); exit(channel, serveSFTP(channel, home)) }()
		case request.Type == "exec" && !started:
			var command struct{ Command string }
			if ssh.Unmarshal(request.Payload, &command) != nil {
				_ = request.Reply(false, nil)
				continue
			}
			started = true
			_ = request.Reply(true, nil)
			go func() { defer close(finished); exit(channel, run(ctx, channel, command.Command, home, env)) }()
		default:
			if request.WantReply {
				_ = request.Reply(false, nil)
			}
		}
	}
	// The client closed the channel: a command still running goes with it.
	cancel()
	if started {
		<-finished
	}
}

func serveSFTP(channel ssh.Channel, home string) int {
	server, err := sftp.NewServer(channel, sftp.WithServerWorkingDirectory(home))
	if err != nil {
		return 1
	}
	defer server.Close()
	if err := server.Serve(); err != nil && !errors.Is(err, io.EOF) {
		return 1
	}
	return 0
}

func run(ctx context.Context, channel ssh.Channel, command, home string, env []string) int {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	cmd.Dir = home
	cmd.Env = append(os.Environ(), env...)
	// A background child still holding the output must not keep the channel open forever.
	cmd.WaitDelay = 2 * time.Second
	ownGroup(cmd)
	cmd.Stdout, cmd.Stderr = channel, channel.Stderr()
	// Stdin is copied by hand: Wait must not wait for a client that never sends EOF.
	input, err := cmd.StdinPipe()
	if err != nil {
		fmt.Fprintln(channel.Stderr(), err)
		return 127
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(channel.Stderr(), err)
		return 127
	}
	go func() { _, _ = io.Copy(input, channel); _ = input.Close() }()
	err = cmd.Wait()
	var failed *exec.ExitError
	if errors.As(err, &failed) {
		if code := failed.ExitCode(); code >= 0 {
			return code
		}
		return 255
	}
	if err != nil {
		return 255
	}
	return 0
}

func exit(channel ssh.Channel, code int) {
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(code)}))
	_ = channel.CloseWrite()
	_ = channel.Close()
}

// direct opens what the client asked for from the server, as sshd's
// direct-tcpip does for a forward: no extra login, one channel per connection.
func direct(incoming ssh.NewChannel) {
	var target struct {
		Host       string
		Port       uint32
		Origin     string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(incoming.ExtraData(), &target); err != nil || target.Port == 0 || target.Port > 65535 {
		_ = incoming.Reject(ssh.ConnectionFailed, "invalid forward target")
		return
	}
	remote, err := net.DialTimeout("tcp", net.JoinHostPort(target.Host, strconv.Itoa(int(target.Port))), 15*time.Second)
	if err != nil {
		_ = incoming.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	defer remote.Close()
	channel, requests, err := incoming.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	go ssh.DiscardRequests(requests)
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(remote, channel)
		if tcp, ok := remote.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(channel, remote)
	_ = channel.CloseWrite()
	<-done
}

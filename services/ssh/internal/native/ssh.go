package native

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
}
type Challenge struct {
	Context     context.Context `json:"-"`
	Connection  string          `json:"connection"`
	Source      string          `json:"source"`
	Prompt      string          `json:"prompt"`
	Kind        string          `json:"kind"`
	Fingerprint string          `json:"fingerprint"`
	Diagnostics string          `json:"diagnostics"`
	Method      string          `json:"method"`
	Peer        AuthPeer        `json:"peer"`
}
type AuthPeer struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
}
type Broker struct {
	client      *ssh.Client
	listener    net.Listener
	name        string
	token       string
	helper      string
	handler     func(Challenge) (string, bool)
	mu          sync.Mutex
	connections map[string]*Connection
	ctx         context.Context
	cancel      context.CancelFunc
}
type Connection struct {
	Stdin       io.WriteCloser
	Stdout      io.ReadCloser
	cmd         *exec.Cmd
	cancel      context.CancelFunc
	ctx         context.Context
	release     func()
	mu          sync.Mutex
	lines       []string
	fingerprint string
	method      string
	peer        AuthPeer
	source      string
	done        chan struct{}
	err         error
	once        sync.Once
	closed      bool
}

func RandomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func NewBroker(handler func(Challenge) (string, bool)) (*Broker, error) {
	helper, err := os.Executable()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	listener, name, err := listenAuthPipe(RandomID())
	if err != nil {
		cancel()
		return nil, err
	}
	b := &Broker{listener: listener, name: name, token: RandomID(), helper: helper, handler: handler, connections: make(map[string]*Connection), ctx: ctx, cancel: cancel}
	go b.serve()
	return b, nil
}
func (b *Broker) Close() {
	b.cancel()
	if b.listener != nil {
		_ = b.listener.Close()
	}
	b.mu.Lock()
	connections := make([]*Connection, 0, len(b.connections))
	for _, connection := range b.connections {
		connections = append(connections, connection)
	}
	b.mu.Unlock()
	for _, connection := range connections {
		connection.Close()
	}
}
func (b *Broker) serve() {
	for {
		conn, err := b.listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(3 * time.Minute))
			var request struct{ Token, Source, Prompt, Hint string }
			if json.NewDecoder(io.LimitReader(conn, 32768)).Decode(&request) != nil || request.Token != b.token {
				return
			}
			b.mu.Lock()
			source := b.connections[request.Source]
			b.mu.Unlock()
			if source == nil {
				return
			}
			source.mu.Lock()
			if source.closed || source.ctx.Err() != nil {
				source.mu.Unlock()
				return
			}
			challenge := Challenge{Context: source.ctx, Connection: request.Source, Source: source.source, Prompt: request.Prompt, Fingerprint: source.fingerprint, Diagnostics: strings.Join(source.lines, "\n"), Kind: "verification-code", Method: source.method, Peer: source.peer}
			method := source.method
			source.mu.Unlock()
			switch {
			case request.Hint == "confirm" || strings.Contains(request.Prompt, "yes/no"):
				challenge.Kind = "hostkey"
			case strings.Contains(request.Prompt, "passphrase for key"):
				challenge.Kind = "passphrase"
			case method == "password" && strings.Contains(strings.ToLower(request.Prompt), "password"):
				challenge.Kind = "password"
			}
			value, ok := b.handler(challenge)
			_ = json.NewEncoder(conn).Encode(map[string]any{"value": value, "ok": ok})
			if !ok {
				source.Close()
			}
		}()
	}
}
func Askpass() int {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	conn, err := dialAuthPipe(ctx, os.Getenv("RHINE_AUTH_PIPE"))
	if err != nil {
		return 1
	}
	defer conn.Close()
	prompt := ""
	if len(os.Args) > 1 {
		prompt = os.Args[len(os.Args)-1]
	}
	request := map[string]string{"Token": os.Getenv("RHINE_AUTH_TOKEN"), "Source": os.Getenv("RHINE_AUTH_SOURCE"), "Prompt": prompt, "Hint": os.Getenv("SSH_ASKPASS_PROMPT")}
	if json.NewEncoder(conn).Encode(request) != nil {
		return 1
	}
	var response struct {
		Value string `json:"value"`
		OK    bool   `json:"ok"`
	}
	if json.NewDecoder(io.LimitReader(conn, 32768)).Decode(&response) != nil || !response.OK {
		return 1
	}
	fmt.Fprintln(os.Stdout, response.Value)
	return 0
}

var fingerprintPattern = regexp.MustCompile("Server host key: [^ ]+ (SHA256:[A-Za-z0-9+/=]+)")
var peerPattern = regexp.MustCompile("^debug1: Authenticating to (.+?):([0-9]+) as '(.+?)'")

func (c *Connection) observeAuthentication(line string) {
	if match := peerPattern.FindStringSubmatch(line); len(match) == 4 {
		port, _ := strconv.Atoi(match[2])
		c.peer = AuthPeer{Host: strings.Trim(match[1], "[]"), Port: port, User: match[3]}
		c.fingerprint, c.method = "", ""
	}
	if match := fingerprintPattern.FindStringSubmatch(line); len(match) == 2 {
		c.fingerprint = match[1]
	}
	if _, value, found := strings.Cut(line, "Next authentication method: "); found {
		c.method = strings.TrimSpace(value)
	}
}

func (b *Broker) Start(parent context.Context, config Config, source, command string, subsystem bool) (*Connection, error) {
	if b.client != nil {
		return b.startAuthenticated(parent, source, command, subsystem)
	}
	if len(config.Args) == 0 || config.Executable == "" {
		return nil, fmt.Errorf("missing SSH command")
	}
	ctx, cancel := context.WithCancel(parent)
	args := append([]string{}, config.Args[:len(config.Args)-1]...)
	if source == "tunnel" {
		args = append(args, "-W", command)
	} else if subsystem {
		args = append(args, "-s")
	}
	args = append(args, config.Args[len(config.Args)-1])
	if source != "tunnel" {
		args = append(args, command)
	}
	cmd := exec.CommandContext(ctx, config.Executable, args...)
	hideProcess(cmd)
	key := RandomID()
	cmd.Env = append(os.Environ(), "SSH_ASKPASS="+b.helper, "SSH_ASKPASS_REQUIRE=force", "RHINE_ASKPASS=1", "RHINE_AUTH_PIPE="+b.name, "RHINE_AUTH_TOKEN="+b.token, "RHINE_AUTH_SOURCE="+key)
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, outputWriter, err := os.Pipe()
	if err != nil {
		cancel()
		input.Close()
		return nil, err
	}
	stderr, stderrWriter, err := os.Pipe()
	if err != nil {
		cancel()
		input.Close()
		output.Close()
		outputWriter.Close()
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = outputWriter, stderrWriter
	connection := &Connection{Stdin: input, Stdout: output, cmd: cmd, cancel: cancel, ctx: ctx, source: source, done: make(chan struct{})}
	b.mu.Lock()
	b.connections[key] = connection
	b.mu.Unlock()
	if err := cmd.Start(); err != nil {
		cancel()
		input.Close()
		output.Close()
		outputWriter.Close()
		stderr.Close()
		stderrWriter.Close()
		b.mu.Lock()
		delete(b.connections, key)
		b.mu.Unlock()
		return nil, err
	}
	outputWriter.Close()
	stderrWriter.Close()
	release := ownProcessTree(cmd)
	connection.mu.Lock()
	if connection.closed {
		release()
	} else {
		connection.release = release
	}
	connection.mu.Unlock()
	go func() {
		defer stderr.Close()
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 4096), 256*1024)
		for scanner.Scan() {
			line := scanner.Text()
			connection.mu.Lock()
			connection.lines = append(connection.lines, line)
			if len(connection.lines) > 30 {
				connection.lines = connection.lines[len(connection.lines)-30:]
			}
			connection.observeAuthentication(line)
			connection.mu.Unlock()
		}
	}()
	go func() {
		// Parent-owned pipes are drained independently of Wait, which must not
		// close stdout before the final SFTP response or probe output is read.
		err := cmd.Wait()
		cancel()
		connection.mu.Lock()
		connection.err = err
		connection.mu.Unlock()
		close(connection.done)
		b.mu.Lock()
		delete(b.connections, key)
		b.mu.Unlock()
	}()
	return connection, nil
}
func (c *Connection) Close() {
	c.once.Do(func() {
		_ = c.Stdin.Close()
		c.cancel()
		c.mu.Lock()
		c.closed = true
		if c.release != nil {
			c.release()
		}
		c.mu.Unlock()
		_ = c.Stdout.Close()
	})
}
func (c *Connection) Error() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err == nil {
		return nil
	}
	message := ""
	for _, line := range c.lines {
		if !strings.HasPrefix(line, "debug") && strings.TrimSpace(line) != "" {
			message = line
		}
	}
	if message == "" {
		message = c.err.Error()
	}
	return errors.New(message)
}
func (c *Connection) Diagnostics() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.lines, "\n")
}
func (b *Broker) Run(ctx context.Context, config Config, source, command string) ([]byte, error) {
	connection, err := b.Start(ctx, config, source, command, false)
	if err != nil {
		return nil, err
	}
	defer connection.Close()
	_ = connection.Stdin.Close()
	data, readErr := io.ReadAll(io.LimitReader(connection.Stdout, 128*1024))
	select {
	case <-connection.done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := connection.Error(); err != nil {
		return data, err
	}
	return data, readErr
}

func Quote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

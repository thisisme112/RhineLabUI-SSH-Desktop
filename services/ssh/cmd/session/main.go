// Command session is the SSH transport for platforms that cannot run OpenSSH.
//
// The desktop drives the real `ssh` binary and reads its `-v` diagnostics
// (electron/session.cjs, src/ssh/events.ts). Android has neither OpenSSH nor
// permission for a sandboxed app to execute one it wrote, so this speaks the
// protocol itself and reports the same stages the desktop derives from those
// log lines.
//
// Every stage is emitted at the point it actually happens — never on a timer,
// and never inferred from something else. Rule R1 of DESKTOP-SSH.md is the
// reason: an animation that is not driven by a real event is decoration.
//
//	connecting      immediately before the TCP dial
//	handshake       the socket is up; the version exchange and key exchange begin
//	hostkey         inside the host key callback, after KEX, before any credential
//	authenticating  the offered key was accepted, so authentication is next
//	opening         authenticated; the PTY and shell are being requested
//	interactive     the shell is running and the terminal stream is live
//	closed          the session ended, with the exit status when there was one
//
// It is a JSON-lines service on stdin/stdout, the same shape as cmd/bridge.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"rhine.local/sshservices/internal/native"
	"rhine.local/sshservices/internal/service"
)

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type answer struct {
	ID       string `json:"id"`
	Value    string `json:"value"`
	Canceled bool   `json:"canceled"`
}

type hostKeyAnswer struct {
	Accept bool `json:"accept"`
}

type authSpec struct {
	Method     string `json:"method"`
	Password   string `json:"password"`
	PrivateKey string `json:"privateKey"`
	Passphrase string `json:"passphrase"`
}

type knownHost struct {
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"`
}

type connectParams struct {
	Host         string          `json:"host"`
	Addresses    []string        `json:"addresses"`
	Port         int             `json:"port"`
	User         string          `json:"user"`
	TimeoutMS    int             `json:"timeoutMs"`
	Auth         *authSpec       `json:"auth"`
	Known        *knownHost      `json:"knownHost"`
	Term         string          `json:"term"`
	Jumps        []connectParams `json:"jumps"`
	KeepAlive    int             `json:"keepAliveInterval"`
	KeepAliveMax int             `json:"keepAliveCountMax"`
}

/** Shared with the renderer. Emitted without an `id`, so it is an event and
 *  never mistaken for the reply to a request. */
type event struct {
	Event       string `json:"event"`
	Phase       string `json:"phase,omitempty"`
	Detail      string `json:"detail,omitempty"`
	KeyType     string `json:"keyType,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Data        string `json:"data,omitempty"`
	// A pointer, because `omitempty` would drop the one value that matters most:
	// a clean exit is code 0, and a client told nothing cannot tell it from a
	// crash. Absent means "no exit status", which is a different statement.
	Code         *int   `json:"code,omitempty"`
	Message      string `json:"message,omitempty"`
	ID           string `json:"id,omitempty"`
	Kind         string `json:"kind,omitempty"`
	Prompt       string `json:"prompt,omitempty"`
	Hop          int    `json:"hop"`
	Intermediate bool   `json:"intermediate,omitempty"`
}

/** A host key the user has not accepted yet. The callback blocks the handshake
 *  while this is outstanding, which is the point: no credential is offered
 *  until the identity of the server has been settled. */
type hostKeyQuery struct {
	reply chan bool
}

type session struct {
	emit          func(any)
	client        *ssh.Client
	shell         *ssh.Session
	stdin         io.WriteCloser
	socket        net.Conn
	services      *service.Service
	timeout       time.Duration
	writeMu       sync.Mutex
	holdMu        sync.Mutex
	hostKey       *hostKeyQuery
	answer        chan answer
	done          chan struct{}
	once          sync.Once
	transports    []*ssh.Client
	currentHop    int
	finalHop      int
	deadlineTimer *time.Timer
}

func (s *session) close() {
	s.once.Do(func() { close(s.done) })
	s.writeMu.Lock()
	shell, client, socket := s.shell, s.client, s.socket
	services := s.services
	transports := s.transports
	if s.deadlineTimer != nil {
		s.deadlineTimer.Stop()
	}
	s.transports = nil
	s.services = nil
	s.stdin, s.shell, s.client, s.socket = nil, nil, nil, nil
	s.writeMu.Unlock()
	if socket != nil {
		_ = socket.Close()
	}
	if services != nil {
		services.Close()
	}
	if shell != nil {
		_ = shell.Close()
	}
	if client != nil {
		_ = client.Close()
	}
	for i := len(transports) - 1; i >= 0; i-- {
		_ = transports[i].Close()
	}
}

func (s *session) deadline(waitingForUser bool) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	socket := s.socket
	if s.deadlineTimer != nil {
		s.deadlineTimer.Stop()
		s.deadlineTimer = nil
	}
	if socket == nil {
		return
	}
	if waitingForUser {
		_ = socket.SetDeadline(time.Time{})
	} else {
		_ = socket.SetDeadline(time.Now().Add(s.timeout))
		// SSH channel-backed connections do not implement deadlines. Close the
		// current channel on expiry as well so a stalled jump handshake ends.
		s.deadlineTimer = time.AfterFunc(s.timeout, func() { _ = socket.Close() })
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("rhine-session 1.0.0 protocol=1")
		return
	}
	encoder := json.NewEncoder(os.Stdout)
	var output sync.Mutex
	emit := func(value any) { output.Lock(); defer output.Unlock(); _ = encoder.Encode(value) }

	current := &session{emit: emit, answer: make(chan answer, 1), done: make(chan struct{})}
	used := false

	scanner := bufio.NewScanner(os.Stdin)
	// A screen repaint or a paste arrives base64-encoded in one line and can be
	// hundreds of kilobytes.
	scanner.Buffer(make([]byte, 65536), 8*1024*1024)
	for scanner.Scan() {
		var message request
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			emit(response{Error: "invalid request"})
			continue
		}
		switch message.Method {
		case "inspect-key":
			var spec authSpec
			if err := json.Unmarshal(message.Params, &spec); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			signer, err := signerFor(&spec)
			if err != nil {
				_, parseErr := ssh.ParsePrivateKey([]byte(spec.PrivateKey))
				var missing *ssh.PassphraseMissingError
				if spec.Passphrase == "" && errors.As(parseErr, &missing) {
					keyType, fingerprint := "encrypted", ""
					if missing.PublicKey != nil {
						keyType = missing.PublicKey.Type()
						fingerprint = ssh.FingerprintSHA256(missing.PublicKey)
					}
					emit(response{ID: message.ID, OK: true, Result: map[string]any{"type": keyType, "fingerprint": fingerprint, "protected": true}})
				} else {
					emit(response{ID: message.ID, Error: err.Error()})
				}
				continue
			}
			emit(response{ID: message.ID, OK: true, Result: map[string]any{"type": signer.PublicKey().Type(), "fingerprint": ssh.FingerprintSHA256(signer.PublicKey()), "protected": spec.Passphrase != ""}})
		case "rpc":
			current.writeMu.Lock()
			instance := current.services
			current.writeMu.Unlock()
			if instance == nil {
				emit(response{ID: message.ID, Error: "服务尚未连接"})
				continue
			}
			var call struct {
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(message.Params, &call); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			go func(message request, callMethod string, params json.RawMessage, instance *service.Service) {
				ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				defer cancel()
				result, err := instance.Call(ctx, callMethod, params)
				emit(response{ID: message.ID, OK: err == nil, Result: result, Error: errorText(err)})
			}(message, call.Method, call.Params, instance)
		case "connect":
			var params connectParams
			if err := json.Unmarshal(message.Params, &params); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			// One connect at a time: a second one would fight the first for the
			// same terminal stream.
			if used {
				emit(response{ID: message.ID, Error: "this agent already owns a connection"})
				continue
			}
			used = true
			emit(response{ID: message.ID, OK: true})
			go func(params connectParams) {
				run(current, params)
			}(params)
		case "hostkey":
			var decision hostKeyAnswer
			if err := json.Unmarshal(message.Params, &decision); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			current.holdMu.Lock()
			query := current.hostKey
			current.hostKey = nil
			current.holdMu.Unlock()
			if query == nil {
				emit(response{ID: message.ID, Error: "no host key is waiting"})
				continue
			}
			query.reply <- decision.Accept
			emit(response{ID: message.ID, OK: true})
		case "answer":
			var reply answer
			if err := json.Unmarshal(message.Params, &reply); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			select {
			case current.answer <- reply:
				emit(response{ID: message.ID, OK: true})
			default:
				emit(response{ID: message.ID, Error: "no prompt is waiting"})
			}
		case "write":
			var params struct {
				Data string `json:"data"`
			}
			if err := json.Unmarshal(message.Params, &params); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			decoded, err := base64.StdEncoding.DecodeString(params.Data)
			if err != nil {
				emit(response{ID: message.ID, Error: "data is not base64"})
				continue
			}
			current.writeMu.Lock()
			stdin := current.stdin
			current.writeMu.Unlock()
			if stdin == nil {
				emit(response{ID: message.ID, Error: "no shell is open"})
				continue
			}
			_, err = stdin.Write(decoded)
			emit(response{ID: message.ID, OK: err == nil, Error: errorText(err)})
		case "resize":
			var params struct {
				Cols int `json:"cols"`
				Rows int `json:"rows"`
			}
			if err := json.Unmarshal(message.Params, &params); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			err := current.windowChange(params.Cols, params.Rows)
			emit(response{ID: message.ID, OK: err == nil, Error: errorText(err)})
		case "stop":
			current.close()
			emit(response{ID: message.ID, OK: true})
			return
		default:
			emit(response{ID: message.ID, Error: "unknown method " + message.Method})
		}
	}
	current.close()
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (s *session) phase(name, detail string) {
	kind := "phase"
	if s.currentHop < s.finalHop {
		kind = "hop"
	}
	s.emit(event{Event: kind, Phase: name, Detail: detail, Hop: s.currentHop})
}

func (s *session) windowChange(cols, rows int) error {
	if cols < 2 || cols > 1000 || rows < 1 || rows > 1000 {
		return errors.New("invalid terminal size")
	}
	s.writeMu.Lock()
	shell := s.shell
	s.writeMu.Unlock()
	if shell == nil {
		return errors.New("no shell is open")
	}
	return shell.WindowChange(rows, cols)
}

/** Ask the renderer whether this key is acceptable, and block the handshake
 *  until it answers or the attempt is given up. */
func (s *session) askHostKey(key ssh.PublicKey) bool {
	s.deadline(true)
	defer s.deadline(false)
	query := &hostKeyQuery{reply: make(chan bool, 1)}
	s.holdMu.Lock()
	s.hostKey = query
	s.holdMu.Unlock()
	s.emit(event{
		Event:       "hostkey",
		KeyType:     key.Type(),
		Fingerprint: ssh.FingerprintSHA256(key),
		Data:        base64.StdEncoding.EncodeToString(key.Marshal()),
		Hop:         s.currentHop, Intermediate: s.currentHop < s.finalHop,
	})
	select {
	case accept := <-query.reply:
		return accept
	case <-s.done:
		return false
	case <-time.After(3 * time.Minute):
		return false
	}
}

/** The bridge's answer-or-prompt pattern, reused: a keyboard-interactive
 *  challenge cannot be answered before the server asks for it. */
func (s *session) ask(kind, prompt string) (string, bool) {
	s.deadline(true)
	defer s.deadline(false)
	id := fmt.Sprintf("p%d", time.Now().UnixNano())
	s.emit(event{Event: "prompt", ID: id, Kind: kind, Prompt: prompt, Hop: s.currentHop})
	for {
		select {
		case reply := <-s.answer:
			if reply.ID != id {
				continue
			}
			return reply.Value, !reply.Canceled
		case <-s.done:
			return "", false
		case <-time.After(3 * time.Minute):
			return "", false
		}
	}
}

func (s *session) authMethods(spec *authSpec) ([]ssh.AuthMethod, error) {
	if spec == nil {
		return nil, errors.New("no authentication was offered")
	}
	switch spec.Method {
	case "password":
		return []ssh.AuthMethod{ssh.PasswordCallback(func() (string, error) {
			if spec.Password != "" {
				return spec.Password, nil
			}
			value, ok := s.ask("password", "password")
			if !ok {
				return "", errors.New("cancelled")
			}
			return value, nil
		})}, nil
	case "publickey":
		signer, err := signerFor(spec)
		if err != nil && spec.Passphrase == "" && strings.Contains(err.Error(), "needs a passphrase") {
			value, ok := s.ask("passphrase", "解锁私钥")
			if !ok {
				return nil, errors.New("cancelled")
			}
			spec.Passphrase = value
			signer, err = signerFor(spec)
		}
		if err != nil {
			return nil, err
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	case "keyboard-interactive":
		return []ssh.AuthMethod{ssh.KeyboardInteractive(func(_ string, _ string, questions []string, echos []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for index, question := range questions {
				value, ok := s.ask("verification-code", question)
				if !ok {
					return nil, errors.New("cancelled")
				}
				answers[index] = value
			}
			return answers, nil
		})}, nil
	default:
		return nil, errors.New("unknown authentication method " + spec.Method)
	}
}

func signerFor(spec *authSpec) (ssh.Signer, error) {
	pem := []byte(spec.PrivateKey)
	if spec.Passphrase != "" {
		return ssh.ParsePrivateKeyWithPassphrase(pem, []byte(spec.Passphrase))
	}
	signer, err := ssh.ParsePrivateKey(pem)
	var needsPassphrase *ssh.PassphraseMissingError
	if errors.As(err, &needsPassphrase) {
		return nil, errors.New("private key needs a passphrase")
	}
	return signer, err
}

func run(s *session, params connectParams) {
	defer s.close()
	if len(params.Jumps) > 3 {
		s.fail("failed", "最多支持三层跳板机")
		return
	}
	hops := append(append([]connectParams{}, params.Jumps...), params)
	clearSecrets := func() {
		for _, hop := range hops {
			if hop.Auth != nil {
				hop.Auth.Password = ""
				hop.Auth.PrivateKey = ""
				hop.Auth.Passphrase = ""
			}
		}
	}
	defer clearSecrets()
	s.finalHop = len(hops) - 1
	var connection *ssh.Client
	var err error
	for index, hop := range hops {
		s.currentHop = index
		connection, err = s.dialHop(hop, connection)
		if hop.Auth != nil {
			hop.Auth.Password = ""
			hop.Auth.PrivateKey = ""
			hop.Auth.Passphrase = ""
		}
		if err != nil {
			s.fail("failed", fmt.Sprintf("%s:%d: %v", hop.Host, hop.Port, err))
			return
		}
		s.writeMu.Lock()
		s.transports = append(s.transports, connection)
		s.client = connection
		s.writeMu.Unlock()
		if index < s.finalHop {
			s.phase("opening", "跳板机已认证")
		}
	}
	socket := s.socket
	s.deadline(false)
	s.phase("opening", "requesting a terminal")

	terminal := params.Term
	if terminal == "" {
		terminal = "xterm-256color"
	}
	shell, err := connection.NewSession()
	if err != nil {
		s.fail("failed", err.Error())
		return
	}
	defer shell.Close()
	if err := shell.RequestPty(terminal, 24, 80, ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}); err != nil {
		s.fail("failed", err.Error())
		return
	}
	stdin, err := shell.StdinPipe()
	if err != nil {
		s.fail("failed", err.Error())
		return
	}
	// Most PTY servers merge stderr into stdout; drain both streams so a server
	// that keeps them separate cannot block and its diagnostics stay visible.
	stdout, err := shell.StdoutPipe()
	if err != nil {
		s.fail("failed", err.Error())
		return
	}
	stderr, err := shell.StderrPipe()
	if err != nil {
		s.fail("failed", err.Error())
		return
	}
	var outputDone sync.WaitGroup
	for _, reader := range []io.Reader{stdout, stderr} {
		outputDone.Add(1)
		go func(reader io.Reader) {
			defer outputDone.Done()
			buffer := make([]byte, 32768)
			for {
				read, err := reader.Read(buffer)
				if read > 0 {
					s.emit(event{Event: "data", Data: base64.StdEncoding.EncodeToString(buffer[:read])})
				}
				if err != nil {
					return
				}
			}
		}(reader)
	}
	if err := shell.Shell(); err != nil {
		s.fail("failed", err.Error())
		return
	}
	s.writeMu.Lock()
	s.shell, s.stdin = shell, stdin
	s.writeMu.Unlock()
	s.deadline(true)
	_ = socket.SetDeadline(time.Time{})
	services := service.NewAuthenticated(native.RandomID(), os.Getenv("RHINE_SSH_RESOURCES"), connection, func(event service.Event) {
		s.emit(map[string]any{"event": "service", "serviceEvent": event.Event, "data": event.Data})
	})
	s.writeMu.Lock()
	s.services = services
	s.writeMu.Unlock()
	s.phase("interactive", "shell running")
	services.StartFiles()
	interval := params.KeepAlive
	if interval > 0 && interval <= 3600 {
		go s.keepAlive(connection, interval, params.KeepAliveMax)
	}

	err = shell.Wait()
	outputDone.Wait()
	s.phase("closed", "session ended")
	zero := 0
	var code *int = &zero
	message := ""
	if err != nil {
		var exit *ssh.ExitError
		if errors.As(err, &exit) {
			status := exit.ExitStatus()
			code = &status
			message = exit.Error()
		} else {
			code = nil
			message = err.Error()
		}
	}
	s.emit(event{Event: "exit", Code: code, Message: message})
	s.close()
}

/** A failure is reported as the phase the desktop's tracker would land on, so
 *  a client can drive the same surface from either transport. */
func (s *session) fail(phase, message string) {
	s.phase(phase, message)
	if s.currentHop < s.finalHop {
		s.emit(event{Event: "phase", Phase: phase, Detail: "跳板连接失败：" + message})
	}
	s.emit(event{Event: "error", Message: strings.TrimSpace(message)})
}

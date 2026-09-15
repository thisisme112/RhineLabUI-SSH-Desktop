// Isolated protocol fixture: real SSH transport, in-memory SFTP, simulated
// collector frames. It never exposes the developer's filesystem to clients.
package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"rhine.local/sshservices/internal/monitor"
)

func main() {
	dir := flag.String("directory", "", "owned temporary directory for fixture identity files")
	port := flag.Int("port", 0, "loopback listening port")
	flag.Parse()
	if *dir == "" {
		panic("--directory is required")
	}
	if err := os.MkdirAll(*dir, 0700); err != nil {
		panic(err)
	}
	_, hostPrivate, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, _ := ssh.NewSignerFromKey(hostPrivate)
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	identity, _ := ssh.MarshalPrivateKey(private, "Rhine isolated test identity")
	encrypted, _ := ssh.MarshalPrivateKeyWithPassphrase(private, "Rhine isolated encrypted test identity", []byte("fixture-passphrase"))
	keyFile, encryptedFile := filepath.Join(*dir, "identity"), filepath.Join(*dir, "encrypted-identity")
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(identity), 0600); err != nil {
		panic(err)
	}
	if err := os.WriteFile(encryptedFile, pem.EncodeToMemory(encrypted), 0600); err != nil {
		panic(err)
	}
	sshPublic, _ := ssh.NewPublicKey(public)
	var output sync.Mutex
	encoder := json.NewEncoder(os.Stdout)
	emit := func(value any) { output.Lock(); defer output.Unlock(); _ = encoder.Encode(value) }
	config := &ssh.ServerConfig{
		ServerVersion: "SSH-2.0-RhineProtocolFixture",
		PasswordCallback: func(meta ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if meta.User() == "password" && string(password) == "fixture-password" {
				return nil, nil
			}
			return nil, errors.New("fixture password rejected")
		},
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if meta.User() == "key" && string(key.Marshal()) == string(sshPublic.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("fixture key rejected")
		},
		KeyboardInteractiveCallback: func(meta ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			if meta.User() != "otp" {
				return nil, errors.New("not an OTP fixture")
			}
			answers, err := challenge("Fixture verification", "Isolated test only", []string{"Verification code: "}, []bool{false})
			if err == nil && len(answers) == 1 && answers[0] == "314159" {
				return nil, nil
			}
			return nil, errors.New("fixture OTP rejected")
		},
	}
	config.AddHostKey(hostKey)
	handlers := sftp.InMemHandler()
	handlers.FileCmd = fixtureCommands{handlers.FileCmd}
	a, b := net.Pipe()
	controlServer := sftp.NewRequestServer(a, handlers)
	go func() { _ = controlServer.Serve() }()
	store, err := sftp.NewClientPipe(b, b)
	if err != nil {
		panic(err)
	}
	defer store.Close()
	defer controlServer.Close()
	_ = store.Mkdir("/data")
	_ = store.Mkdir("/cache")
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(*port))
	if err != nil {
		panic(err)
	}
	defer listener.Close()
	var connections sync.Map
	var work sync.WaitGroup
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	emit(map[string]any{"event": "ready", "port": listener.Addr().(*net.TCPAddr).Port, "hostKey": strings.TrimSpace(string(ssh.MarshalAuthorizedKey(hostKey.PublicKey()))), "fingerprint": ssh.FingerprintSHA256(hostKey.PublicKey()), "identity": keyFile, "encryptedIdentity": encryptedFile})
	go func() {
		for {
			socket, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Store(socket, true)
			work.Add(1)
			go func() {
				defer work.Done()
				defer socket.Close()
				defer connections.Delete(socket)
				connection, channels, requests, err := ssh.NewServerConn(socket, config)
				if err != nil {
					return
				}
				defer connection.Close()
				go ssh.DiscardRequests(requests)
				emit(map[string]any{"event": "authenticated", "user": connection.User()})
				for incoming := range channels {
					if incoming.ChannelType() == "direct-tcpip" {
						var address struct {
							Host       string
							Port       uint32
							Origin     string
							OriginPort uint32
						}
						if ssh.Unmarshal(incoming.ExtraData(), &address) != nil || address.Host != "127.0.0.1" || int(address.Port) != listener.Addr().(*net.TCPAddr).Port {
							_ = incoming.Reject(ssh.Prohibited, "fixture forwarding is loopback-only")
							continue
						}
						remote, err := net.Dial("tcp", net.JoinHostPort(address.Host, strconv.Itoa(int(address.Port))))
						if err != nil {
							_ = incoming.Reject(ssh.ConnectionFailed, "fixture connect failed")
							continue
						}
						channel, requests, err := incoming.Accept()
						if err != nil {
							remote.Close()
							continue
						}
						go ssh.DiscardRequests(requests)
						go func() {
							defer remote.Close()
							defer channel.Close()
							done := make(chan struct{})
							go func() { _, _ = io.Copy(remote, channel); remote.Close(); close(done) }()
							_, _ = io.Copy(channel, remote)
							channel.Close()
							<-done
						}()
						continue
					}
					if incoming.ChannelType() != "session" {
						_ = incoming.Reject(ssh.UnknownChannelType, "unsupported fixture channel")
						continue
					}
					channel, requests, err := incoming.Accept()
					if err != nil {
						continue
					}
					go func() {
						defer channel.Close()
						for request := range requests {
							switch request.Type {
							case "env", "pty-req", "window-change":
								if request.Type == "window-change" {
									var size struct{ Cols, Rows, Width, Height uint32 }
									_ = ssh.Unmarshal(request.Payload, &size)
									emit(map[string]any{"event": "resize", "cols": size.Cols, "rows": size.Rows})
								}
								_ = request.Reply(true, nil)
							case "subsystem":
								var subsystem struct{ Name string }
								_ = ssh.Unmarshal(request.Payload, &subsystem)
								if subsystem.Name != "sftp" {
									_ = request.Reply(false, nil)
									return
								}
								_ = request.Reply(true, nil)
								server := sftp.NewRequestServer(channel, handlers)
								_ = server.Serve()
								_ = server.Close()
								return
							case "shell":
								_ = request.Reply(true, nil)
								go func() {
									defer channel.Close()
									_, _ = io.WriteString(channel, "Isolated SSH fixture\r\nfixture$ ")
									reader := bufio.NewScanner(channel)
									for reader.Scan() {
										line := strings.TrimSuffix(reader.Text(), "\r")
										if line == "disconnect" {
											return
										}
										if line == "exit" || line == "exit17" {
											status := uint32(0)
											if line == "exit17" {
												status = 17
											}
											_, _ = io.WriteString(channel, "fixture: goodbye\r\n")
											_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
											return
										}
										if line == "stderr" {
											_, _ = io.WriteString(channel.Stderr(), "fixture: stderr\r\n")
										}
										_, _ = fmt.Fprintf(channel, "fixture: %s\r\nfixture$ ", line)
									}
								}()
							case "exec":
								var command struct{ Command string }
								_ = ssh.Unmarshal(request.Payload, &command)
								_ = request.Reply(true, nil)
								if nonce := regexp.MustCompile(`RHINE_[a-f0-9]+`).FindString(command.Command); nonce != "" {
									_, _ = fmt.Fprintf(channel, "%s\nLinux\nx86_64\n/cache\n", nonce)
								} else if strings.HasPrefix(command.Command, "exec ") && strings.Contains(command.Command, "/cache/rhine-lab/monitor/") {
									monitorFixture(ctx, channel, emit)
								} else {
									_, _ = io.WriteString(channel, "fixture-command-output\n")
								}
								_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
								return
							default:
								_ = request.Reply(false, nil)
							}
						}
					}()
				}
			}()
		}
	}()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 8*1024*1024)
	for scanner.Scan() {
		var request struct {
			ID     string
			Method string
			Path   string
			Data   string
			Target string
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			continue
		}
		var result any
		var err error
		switch request.Method {
		case "drop":
			connections.Range(func(key, value any) bool { _ = key.(net.Conn).Close(); return true })
		case "mkdir":
			err = store.MkdirAll(request.Path)
		case "symlink":
			err = store.Symlink(request.Target, request.Path)
		case "seed":
			var data []byte
			data, err = base64.StdEncoding.DecodeString(request.Data)
			if err == nil {
				var file *sftp.File
				file, err = store.Create(request.Path)
				if err == nil {
					_, err = file.Write(data)
					_ = file.Close()
				}
			}
		case "read":
			var file *sftp.File
			file, err = store.Open(request.Path)
			if err == nil {
				var data []byte
				data, err = io.ReadAll(file)
				_ = file.Close()
				result = base64.StdEncoding.EncodeToString(data)
			}
		case "list":
			var entries []os.FileInfo
			entries, err = store.ReadDir(request.Path)
			names := []string{}
			for _, entry := range entries {
				names = append(names, entry.Name())
			}
			result = names
		case "stop":
			cancel()
		}
		reply := map[string]any{"id": request.ID, "ok": err == nil, "result": result}
		if err != nil {
			reply["error"] = err.Error()
		}
		emit(reply)
		if request.Method == "stop" {
			break
		}
	}
	cancel()
	listener.Close()
	connections.Range(func(key, value any) bool { _ = key.(net.Conn).Close(); return true })
	work.Wait()
}

// pkg/sftp's example memory filesystem rejects chmod on directories and does
// not model permission bits. This fixture only acknowledges metadata requests;
// filesystem permission behaviour remains part of real-host acceptance.
type fixtureCommands struct{ sftp.FileCmder }

func (commands fixtureCommands) Filecmd(request *sftp.Request) error {
	if request.Method == "Setstat" && !request.AttrFlags().Size {
		return nil
	}
	return commands.FileCmder.Filecmd(request)
}
func (commands fixtureCommands) PosixRename(request *sftp.Request) error {
	return commands.FileCmder.(sftp.PosixRenameFileCmder).PosixRename(request)
}

func monitorFixture(parent context.Context, channel ssh.Channel, emit func(any)) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	emit(map[string]any{"event": "monitor-started"})
	defer emit(map[string]any{"event": "monitor-stopped"})
	go func() {
		scanner := bufio.NewScanner(channel)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "stop") {
				break
			}
		}
		cancel()
	}()
	encoder := json.NewEncoder(channel)
	if encoder.Encode(map[string]any{"type": "hello", "protocol": 1, "version": "fixture", "pid": 12345}) != nil {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var sequence uint64
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			sequence++
			cpu := float64(sequence % 100)
			sample := monitor.Sample{Sequence: sequence, Timestamp: now.UnixMilli(), Hostname: "SIMULATED-COLLECTOR-FIXTURE", CPU: &monitor.CPU{Usage: &cpu, Cores: 8, Load: []float64{1, 1, 1}}, Memory: &monitor.Memory{Total: 8 << 30, Used: 2 << 30, Available: 6 << 30}, Disks: []monitor.Disk{}, Networks: []monitor.Network{}, GPUs: []monitor.GPU{}, GPUState: "unavailable", GPUError: "Simulated collector; no hardware claim"}
			if encoder.Encode(map[string]any{"type": "sample", "sample": sample}) != nil {
				return
			}
		}
	}
}

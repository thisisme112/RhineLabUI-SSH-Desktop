package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"rhine.local/sshservices/internal/native"
)

type Config struct {
	SessionID string        `json:"sessionId"`
	SSH       native.Config `json:"ssh"`
	Resources string        `json:"resources"`
}
type Event struct {
	Event     string `json:"event"`
	SessionID string `json:"sessionId"`
	Data      any    `json:"data"`
}
type Entry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	Size        int64  `json:"size"`
	Modified    int64  `json:"modified"`
	Permissions string `json:"permissions"`
}
type Service struct {
	Config            Config
	Emit              func(Event)
	ctx               context.Context
	cancel            context.CancelFunc
	Broker            *native.Broker
	mu                sync.Mutex
	commitMu          sync.Mutex
	client            *sftp.Client
	connection        *native.Connection
	connecting        bool
	monitorCancel     context.CancelFunc
	monitorGeneration uint64
	jobs              map[string]*Job
	slots             chan struct{}
	wg                sync.WaitGroup
	listings          map[string]listing
	tunnels           map[string]*tunnel
}
type listing struct {
	path    string
	entries []Entry
	expires time.Time
}

func New(config Config, emit func(Event), auth func(native.Challenge) (string, bool)) (*Service, error) {
	if config.SessionID == "" || len(config.SSH.Args) == 0 {
		return nil, errors.New("invalid session configuration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	broker, err := native.NewBroker(auth)
	if err != nil {
		cancel()
		return nil, err
	}
	return &Service{Config: config, Emit: emit, ctx: ctx, cancel: cancel, Broker: broker, jobs: make(map[string]*Job), slots: make(chan struct{}, 2), listings: make(map[string]listing)}, nil
}

// Shares the desktop file / transfer / monitor implementation with Android;
// only channel creation differs between system OpenSSH and x/crypto/ssh.
func NewAuthenticated(sessionID, resources string, client *ssh.Client, emit func(Event)) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{Config: Config{SessionID: sessionID, Resources: resources}, Emit: emit, ctx: ctx, cancel: cancel, Broker: native.NewAuthenticatedBroker(client), jobs: make(map[string]*Job), slots: make(chan struct{}, 2), listings: make(map[string]listing)}
}
func (s *Service) event(kind string, data any) {
	s.Emit(Event{Event: kind, SessionID: s.Config.SessionID, Data: data})
}
func (s *Service) capability(kind, state, message string) {
	s.event("capability", map[string]any{"service": kind, "state": state, "message": message})
}
func (s *Service) Close() {
	s.cancel()
	s.mu.Lock()
	if s.monitorCancel != nil {
		s.monitorCancel()
	}
	client, connection := s.client, s.connection
	s.client, s.connection = nil, nil
	for _, job := range s.jobs {
		job.cancel()
	}
	tunnels := make([]*tunnel, 0, len(s.tunnels))
	for _, t := range s.tunnels {
		t.cancel()
		_ = t.listener.Close()
		tunnels = append(tunnels, t)
	}
	s.mu.Unlock()
	if client != nil {
		_ = client.Close()
	}
	if connection != nil {
		connection.Close()
	}
	s.Broker.Close()
	for _, t := range tunnels {
		<-t.done
	}
	s.wg.Wait()
}
func (s *Service) StartFiles() {
	s.mu.Lock()
	if s.connecting || s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.connecting = true
	s.wg.Add(1)
	old, oldConnection := s.client, s.connection
	s.client, s.connection = nil, nil
	s.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	if oldConnection != nil {
		oldConnection.Close()
	}
	go func() {
		defer s.wg.Done()
		defer func() { s.mu.Lock(); s.connecting = false; s.mu.Unlock() }()
		s.capability("sftp", "connecting", "正在建立文件通道")
		connection, err := s.Broker.Start(s.ctx, s.Config.SSH, "sftp", "sftp", true)
		if err != nil {
			s.capability("sftp", "error", err.Error())
			s.monitorWaitingForFiles()
			return
		}
		client, err := sftp.NewClientPipe(connection.Stdout, connection.Stdin,
			sftp.MaxConcurrentRequestsPerFile(16), sftp.UseConcurrentWrites(true))
		if err != nil {
			diagnostic := connection.Diagnostics()
			connection.Close()
			if diagnostic != "" {
				err = fmt.Errorf("%v\n%s", err, diagnostic)
			}
			s.capability("sftp", "error", err.Error())
			s.monitorWaitingForFiles()
			return
		}
		s.mu.Lock()
		if s.ctx.Err() != nil {
			s.mu.Unlock()
			client.Close()
			connection.Close()
			return
		}
		s.client, s.connection = client, connection
		s.mu.Unlock()
		home, err := client.RealPath(".")
		if err != nil {
			client.Close()
			connection.Close()
			s.mu.Lock()
			if s.client == client {
				s.client, s.connection = nil, nil
			}
			s.mu.Unlock()
			s.capability("sftp", "error", err.Error())
			s.monitorWaitingForFiles()
			return
		}
		s.event("capability", map[string]any{"service": "sftp", "state": "ready", "message": "文件通道已建立", "home": home})
		s.StartMonitor()
		go func() {
			err := client.Wait()
			s.mu.Lock()
			current := s.client == client
			if current {
				s.client, s.connection = nil, nil
			}
			s.mu.Unlock()
			connection.Close()
			if current && s.ctx.Err() == nil {
				message := "文件通道已关闭"
				if err != nil {
					message = err.Error()
				}
				s.capability("sftp", "error", message)
			}
		}()
	}()
}
func (s *Service) monitorWaitingForFiles() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() == nil && s.monitorGeneration == 0 {
		s.capability("monitor", "error", "文件通道未建立，暂时无法准备监控；请重试文件连接")
	}
}
func (s *Service) files() (*sftp.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return nil, errors.New("会话已结束")
	}
	if s.client == nil {
		return nil, errors.New("文件通道尚未就绪")
	}
	return s.client, nil
}

// Most SFTP metadata requests do not accept a context. If one exceeds its RPC
// deadline, end that file channel so it cannot mutate files after a timeout was
// already reported. The primary terminal and monitor channel stay independent.
func (s *Service) watchFiles(ctx context.Context) func() {
	s.mu.Lock()
	client, connection := s.client, s.connection
	s.mu.Unlock()
	stop := context.AfterFunc(ctx, func() {
		s.mu.Lock()
		current := client != nil && s.client == client
		if current {
			s.client, s.connection = nil, nil
		}
		s.mu.Unlock()
		if !current {
			return
		}
		if connection != nil {
			connection.Close()
		}
		_ = client.Close()
		if s.ctx.Err() == nil {
			s.capability("sftp", "error", "文件操作超时，已结束文件通道；请核查结果并重新连接")
		}
	})
	return func() { stop() }
}
func ValidPath(value string) bool {
	return value != "" && len(value) <= 8192 && !strings.ContainsRune(value, 0)
}
func validName(value string) bool {
	return value != "" && value != "." && value != ".." && !strings.ContainsAny(value, "/\x00")
}
func entry(name, full string, info os.FileInfo) Entry {
	kind := "file"
	if info.Mode()&os.ModeSymlink != 0 {
		kind = "link"
	} else if info.IsDir() {
		kind = "directory"
	} else if !info.Mode().IsRegular() {
		kind = "special"
	}
	return Entry{Name: name, Path: full, Kind: kind, Size: info.Size(), Modified: info.ModTime().UnixMilli(), Permissions: info.Mode().String()}
}
func (s *Service) List(ctx context.Context, requested, cursor string) (any, error) {
	if !ValidPath(requested) {
		return nil, errors.New("目录路径无效")
	}
	if cursor != "" {
		token, offsetText, ok := strings.Cut(cursor, ":")
		offset, err := strconv.Atoi(offsetText)
		s.mu.Lock()
		cached, found := s.listings[token]
		s.mu.Unlock()
		if !ok || err != nil || !found || cached.path != requested || time.Now().After(cached.expires) || offset < 0 || offset > len(cached.entries) {
			return nil, errors.New("目录快照已过期，请刷新")
		}
		return pageOf(token, cached, offset), nil
	}
	client, err := s.files()
	if err != nil {
		return nil, err
	}
	full, err := client.RealPath(requested)
	if err != nil {
		return nil, err
	}
	infos, err := client.ReadDirContext(ctx, full)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(infos))
	for _, info := range infos {
		if !validName(info.Name()) {
			continue
		}
		entries = append(entries, entry(info.Name(), path.Join(full, info.Name()), info))
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if (entries[i].Kind == "directory") != (entries[j].Kind == "directory") {
			return entries[i].Kind == "directory"
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	token := native.RandomID()
	cached := listing{full, entries, time.Now().Add(90 * time.Second)}
	s.mu.Lock()
	if len(s.listings) >= 2 {
		s.listings = make(map[string]listing)
	}
	s.listings[token] = cached
	s.mu.Unlock()
	return pageOf(token, cached, 0), nil
}
func pageOf(token string, cached listing, offset int) any {
	end := min(offset+500, len(cached.entries))
	next := ""
	if end < len(cached.entries) {
		next = token + ":" + strconv.Itoa(end)
	}
	return map[string]any{"path": cached.path, "entries": cached.entries[offset:end], "total": len(cached.entries), "cursor": next}
}
func (s *Service) Stat(requested string) (any, error) {
	if !ValidPath(requested) {
		return nil, errors.New("文件路径无效")
	}
	client, err := s.files()
	if err != nil {
		return nil, err
	}
	info, err := client.Lstat(requested)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"entry": entry(path.Base(requested), requested, info)}
	if info.Mode()&os.ModeSymlink != 0 {
		target, _ := client.ReadLink(requested)
		result["linkTarget"] = target
		if followed, err := client.Stat(requested); err == nil {
			result["targetKind"] = entry(path.Base(requested), requested, followed).Kind
		}
	}
	return result, nil
}
func protected(value string) bool {
	clean := path.Clean(value)
	return clean == "/" || clean == "." || clean == ".."
}
func (s *Service) Mutate(ctx context.Context, method, source, destination string, recursive bool) error {
	if !ValidPath(source) || protected(source) {
		return errors.New("不能修改根目录或无效路径")
	}
	client, err := s.files()
	if err != nil {
		return err
	}
	switch method {
	case "mkdir":
		return client.Mkdir(source)
	case "rename":
		if !ValidPath(destination) || protected(destination) {
			return errors.New("新路径无效")
		}
		if _, err := client.Lstat(destination); err == nil {
			return errors.New("目标已存在，请选择其他名称")
		} else if !os.IsNotExist(err) {
			return err
		}
		return client.Rename(source, destination)
	case "remove":
		return removeRemote(ctx, client, source, recursive)
	}
	return errors.New("未知文件操作")
}
func removeRemote(ctx context.Context, client *sftp.Client, full string, recursive bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := client.Lstat(full)
	if err != nil {
		return err
	}
	if info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		if recursive {
			infos, err := client.ReadDirContext(ctx, full)
			if err != nil {
				return err
			}
			for _, info := range infos {
				if !validName(info.Name()) {
					return errors.New("服务器返回了无效文件名")
				}
				if err := removeRemote(ctx, client, path.Join(full, info.Name()), true); err != nil {
					return err
				}
			}
		}
		return client.RemoveDirectory(full)
	}
	return client.Remove(full)
}
func (s *Service) Call(ctx context.Context, method string, data json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if method == "list" || method == "stat" || method == "mkdir" || method == "rename" || method == "remove" || method == "retry" || method == "readText" || method == "writeText" {
		defer s.watchFiles(ctx)()
	}
	switch method {
	case "tunnels":
		return s.ListTunnels(), nil
	case "startTunnel", "stopTunnel":
		var p struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			Host      string `json:"host"`
			Port      int    `json:"port"`
			LocalPort int    `json:"localPort"`
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return nil, err
		}
		if method == "stopTunnel" {
			return s.StopTunnel(p.ID)
		}
		return s.StartTunnel(p.Name, p.Host, p.Port, p.LocalPort)
	case "readText", "writeText":
		var params struct {
			Path     string `json:"path"`
			Text     string `json:"text"`
			Revision string `json:"revision"`
		}
		if err := json.Unmarshal(data, &params); err != nil {
			return nil, err
		}
		if method == "readText" {
			return s.ReadText(ctx, params.Path)
		}
		return s.WriteText(ctx, params.Path, params.Text, params.Revision)
	case "list", "stat", "mkdir", "rename", "remove":
		var params struct {
			Path        string `json:"path"`
			Destination string `json:"destination"`
			Recursive   bool   `json:"recursive"`
			Cursor      string `json:"cursor"`
		}
		if err := json.Unmarshal(data, &params); err != nil {
			return nil, err
		}
		if method == "list" {
			return s.List(ctx, params.Path, params.Cursor)
		}
		if method == "stat" {
			return s.Stat(params.Path)
		}
		return nil, s.Mutate(ctx, method, params.Path, params.Destination, params.Recursive)
	case "upload", "download":
		var spec JobSpec
		if err := json.Unmarshal(data, &spec); err != nil {
			return nil, err
		}
		spec.Direction = method
		return s.Queue(spec)
	case "cancel", "retry", "conflict":
		var params struct {
			ID         string `json:"id"`
			Choice     string `json:"choice"`
			All        bool   `json:"all"`
			ConflictID string `json:"conflictId"`
		}
		if err := json.Unmarshal(data, &params); err != nil {
			return nil, err
		}
		return s.ControlJob(method, params.ID, params.Choice, params.All, params.ConflictID)
	case "filesRetry":
		s.StartFiles()
		return nil, nil
	case "monitorRetry":
		s.StartMonitor()
		return nil, nil
	}
	return nil, errors.New("未知服务操作")
}

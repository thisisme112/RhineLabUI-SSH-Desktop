package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"sync"

	"rhine.local/sshservices/internal/native"
)

type TunnelState struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	State        string `json:"state"`
	LocalAddress string `json:"localAddress"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Connections  int    `json:"connections"`
	Error        string `json:"error,omitempty"`
}
type tunnel struct {
	state    TunnelState
	listener net.Listener
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	done     chan struct{}
}

func (t *tunnel) snapshot() TunnelState { t.mu.Lock(); defer t.mu.Unlock(); return t.state }

var forwardHost = regexp.MustCompile(`^[a-zA-Z0-9.:\[\]_-]{1,253}$`)

func (s *Service) StartTunnel(name, host string, port, localPort int) (any, error) {
	if len(name) > 100 || !forwardHost.MatchString(host) || port < 1 || port > 65535 || localPort < 0 || localPort > 65535 {
		return nil, errors.New("转发地址或端口无效")
	}
	host = strings.Trim(host, "[]")
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return nil, errors.New("SSH 会话已结束")
	}
	if s.tunnels == nil {
		s.tunnels = make(map[string]*tunnel)
	}
	live := 0
	for id, t := range s.tunnels {
		if t.snapshot().State != "closed" {
			live++
		} else {
			delete(s.tunnels, id)
		}
	}
	if live >= 16 {
		return nil, errors.New("每个会话最多 16 个端口转发")
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(s.ctx)
	t := &tunnel{state: TunnelState{ID: native.RandomID(), Name: name, State: "listening", LocalAddress: listener.Addr().String(), Host: host, Port: port}, listener: listener, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	s.tunnels[t.state.ID] = t
	go s.serveTunnel(t)
	s.event("tunnel", t.snapshot())
	return t.snapshot(), nil
}
func (s *Service) serveTunnel(t *tunnel) {
	defer close(t.done)
	unhook := context.AfterFunc(t.ctx, func() { _ = t.listener.Close() })
	defer unhook()
	var workers sync.WaitGroup
	slots := make(chan struct{}, 16)
	for {
		local, err := t.listener.Accept()
		if err != nil {
			break
		}
		select {
		case slots <- struct{}{}:
		default:
			_ = local.Close()
			continue
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-slots }()
			defer local.Close()
			stopLocal := context.AfterFunc(t.ctx, func() { _ = local.Close() })
			defer stopLocal()
			remote, err := s.Broker.OpenForward(t.ctx, s.Config.SSH, net.JoinHostPort(t.state.Host, fmt.Sprint(t.state.Port)))
			if err != nil {
				t.mu.Lock()
				t.state.Error = err.Error()
				t.mu.Unlock()
				s.event("tunnel", t.snapshot())
				return
			}
			defer remote.Close()
			stopRemote := context.AfterFunc(t.ctx, func() { _ = remote.Close() })
			defer stopRemote()
			t.mu.Lock()
			t.state.Connections++
			t.state.Error = ""
			t.mu.Unlock()
			s.event("tunnel", t.snapshot())
			defer func() { t.mu.Lock(); t.state.Connections--; t.mu.Unlock(); s.event("tunnel", t.snapshot()) }()
			copied := make(chan struct{})
			go func() {
				defer close(copied)
				_, _ = io.Copy(remote, local)
				if writer, ok := remote.(interface{ CloseWrite() error }); ok {
					_ = writer.CloseWrite()
				}
			}()
			_, copyErr := io.Copy(local, remote)
			_ = local.Close()
			_ = remote.Close()
			<-copied
			if copyErr != nil && t.ctx.Err() == nil {
				t.mu.Lock()
				t.state.Error = copyErr.Error()
				t.mu.Unlock()
			}
		}()
	}
	t.cancel()
	workers.Wait()
	t.mu.Lock()
	t.state.State = "closed"
	t.mu.Unlock()
	s.event("tunnel", t.snapshot())
}
func (s *Service) StopTunnel(id string) (any, error) {
	s.mu.Lock()
	t := s.tunnels[id]
	s.mu.Unlock()
	if t == nil {
		return nil, errors.New("转发已不存在")
	}
	t.cancel()
	_ = t.listener.Close()
	return nil, nil
}
func (s *Service) ListTunnels() []TunnelState {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := []TunnelState{}
	for _, t := range s.tunnels {
		result = append(result, t.snapshot())
	}
	return result
}

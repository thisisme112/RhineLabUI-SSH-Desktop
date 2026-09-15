package main

import (
	"context"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"net"
	"strings"
	"time"
)

func (s *session) dialHop(p connectParams, previous *ssh.Client) (*ssh.Client, error) {
	if strings.TrimSpace(p.Host) == "" || strings.TrimSpace(p.User) == "" || p.Port < 0 || p.Port > 65535 {
		return nil, errors.New("invalid host, user or port")
	}
	port := p.Port
	if port == 0 {
		port = 22
	}
	timeout := time.Duration(p.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	if timeout > 2*time.Minute {
		timeout = 2 * time.Minute
	}
	s.timeout = timeout
	auth, err := s.authMethods(p.Auth)
	if err != nil {
		return nil, err
	}
	address := net.JoinHostPort(p.Host, fmt.Sprint(port))
	s.phase("connecting", address)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	go func() {
		select {
		case <-s.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	var socket net.Conn
	if previous != nil {
		socket, err = previous.DialContext(ctx, "tcp", address)
	} else {
		addresses := []string{address}
		if len(p.Addresses) > 0 {
			addresses = nil
			for _, ip := range p.Addresses {
				if net.ParseIP(ip) == nil {
					return nil, errors.New("invalid resolved address")
				}
				addresses = append(addresses, net.JoinHostPort(ip, fmt.Sprint(port)))
			}
		}
		for _, candidate := range addresses {
			socket, err = (&net.Dialer{}).DialContext(ctx, "tcp", candidate)
			if err == nil {
				break
			}
		}
	}
	if err != nil {
		return nil, err
	}
	select {
	case <-s.done:
		_ = socket.Close()
		return nil, errors.New("cancelled")
	default:
	}
	s.writeMu.Lock()
	s.socket = socket
	s.writeMu.Unlock()
	s.deadline(false)
	s.phase("handshake", "tcp established")
	config := &ssh.ClientConfig{User: p.User, Auth: auth, Timeout: timeout, HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fingerprint := ssh.FingerprintSHA256(key)
		if p.Known != nil && p.Known.Fingerprint != "" {
			if p.Known.Fingerprint != fingerprint || p.Known.KeyType != key.Type() {
				return fmt.Errorf("host key changed: recorded %s, presented %s", p.Known.Fingerprint, fingerprint)
			}
		} else if !s.askHostKey(key) {
			return errors.New("host key not accepted")
		}
		s.phase("authenticating", "host identity verified; authenticating as "+p.User)
		return nil
	}}
	client, channels, requests, err := ssh.NewClientConn(socket, address, config)
	if err != nil {
		_ = socket.Close()
		return nil, err
	}
	s.deadline(true)
	return ssh.NewClient(client, channels, requests), nil
}
func (s *session) keepAlive(client *ssh.Client, interval, max int) {
	if max < 1 || max > 30 {
		max = 3
	}
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			done := make(chan error, 1)
			go func() { _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); done <- err }()
			select {
			case <-s.done:
				return
			case err := <-done:
				if err != nil {
					s.close()
					return
				}
			case <-time.After(time.Duration(interval*max) * time.Second):
				s.close()
				return
			}
		}
	}
}

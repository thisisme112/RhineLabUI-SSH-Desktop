package native

import (
	"bufio"
	"context"
	"golang.org/x/crypto/ssh"
	"io"
)

// Android already owns an authenticated SSH transport. Auxiliary channels use
// that exact transport and host identity, without another credential exchange.
func NewAuthenticatedBroker(client *ssh.Client) *Broker {
	ctx, cancel := context.WithCancel(context.Background())
	return &Broker{client: client, ctx: ctx, cancel: cancel, connections: make(map[string]*Connection)}
}
func (b *Broker) startAuthenticated(parent context.Context, source, command string, subsystem bool) (*Connection, error) {
	ctx, cancel := context.WithCancel(parent)
	unhook := context.AfterFunc(b.ctx, cancel)
	var remote *ssh.Session
	var err error
	ready := make(chan struct{})
	go func() { remote, err = b.client.NewSession(); close(ready) }()
	select {
	case <-ctx.Done():
		go func() {
			<-ready
			if remote != nil {
				_ = remote.Close()
			}
		}()
		unhook()
		cancel()
		return nil, ctx.Err()
	case <-ready:
	}
	if err != nil {
		unhook()
		cancel()
		return nil, err
	}
	closeRemote := context.AfterFunc(ctx, func() { _ = remote.Close() })
	release := func() { unhook(); cancel(); closeRemote(); _ = remote.Close() }
	input, err := remote.StdinPipe()
	if err != nil {
		release()
		return nil, err
	}
	output, err := remote.StdoutPipe()
	if err != nil {
		release()
		return nil, err
	}
	stderr, err := remote.StderrPipe()
	if err != nil {
		release()
		return nil, err
	}
	connection := &Connection{Stdin: input, Stdout: io.NopCloser(output), cancel: cancel, ctx: ctx, source: source, done: make(chan struct{}), release: release}
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 4096), 256*1024)
		for scanner.Scan() {
			connection.mu.Lock()
			connection.lines = append(connection.lines, scanner.Text())
			if len(connection.lines) > 30 {
				connection.lines = connection.lines[len(connection.lines)-30:]
			}
			connection.mu.Unlock()
		}
	}()
	if subsystem {
		err = remote.RequestSubsystem(command)
	} else {
		err = remote.Start(command)
	}
	if err != nil {
		connection.Close()
		return nil, err
	}
	key := RandomID()
	b.mu.Lock()
	b.connections[key] = connection
	b.mu.Unlock()
	go func() {
		err := remote.Wait()
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

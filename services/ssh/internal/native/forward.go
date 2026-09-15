package native

import (
	"context"
	"io"
)

type forwardStream struct{ connection *Connection }

func (s *forwardStream) Read(p []byte) (int, error) {
	n, err := s.connection.Stdout.Read(p)
	if err == io.EOF {
		<-s.connection.done
		if failure := s.connection.Error(); failure != nil {
			return n, failure
		}
	}
	return n, err
}
func (s *forwardStream) Write(p []byte) (int, error) { return s.connection.Stdin.Write(p) }
func (s *forwardStream) Close() error                { s.connection.Close(); return nil }
func (s *forwardStream) CloseWrite() error           { return s.connection.Stdin.Close() }

// Android reuses its authenticated transport. Desktop uses a managed OpenSSH
// direct-tcpip channel, preserving SSH config, agent and native credential flow.
// -W opens no remote shell and cannot inherit configured listener sockets.
func (b *Broker) OpenForward(ctx context.Context, config Config, address string) (io.ReadWriteCloser, error) {
	if b.client != nil {
		return b.client.DialContext(ctx, "tcp", address)
	}
	connection, err := b.Start(ctx, config, "tunnel", address, false)
	if err != nil {
		return nil, err
	}
	return &forwardStream{connection}, nil
}

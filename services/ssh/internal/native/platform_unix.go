//go:build !windows

package native

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

type authListener struct {
	net.Listener
	directory string
}

func (l *authListener) Close() error {
	err := l.Listener.Close()
	_ = os.RemoveAll(l.directory)
	return err
}
func listenAuthPipe(id string) (net.Listener, string, error) {
	dir, err := os.MkdirTemp("", "rhine-auth-")
	if err != nil {
		return nil, "", err
	}
	name := filepath.Join(dir, "auth.sock")
	listener, err := net.Listen("unix", name)
	if err != nil {
		os.RemoveAll(dir)
		return nil, "", err
	}
	return &authListener{listener, dir}, name, nil
}
func dialAuthPipe(ctx context.Context, name string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", name)
}
func hideProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func ownProcessTree(cmd *exec.Cmd) func() {
	return func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
}

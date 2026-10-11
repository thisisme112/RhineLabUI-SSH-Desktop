//go:build !windows

package agent

import (
	"os/exec"
	"syscall"
)

// ownGroup puts the command in its own process group, so a cancelled channel
// ends whatever the command started as well.
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

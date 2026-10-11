//go:build windows

package agent

import "os/exec"

// The agent runs on Linux servers; this keeps the package building on Windows.
func ownGroup(cmd *exec.Cmd) {}

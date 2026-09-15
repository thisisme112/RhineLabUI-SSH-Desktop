//go:build !linux

package monitor

import "fmt"

func diskUsage(path string) (Disk, error) { return Disk{}, fmt.Errorf("Linux collector required") }

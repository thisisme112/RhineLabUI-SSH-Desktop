package monitor

import "syscall"

func diskUsage(path string) (Disk, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return Disk{}, err
	}
	block := uint64(stat.Bsize)
	return Disk{Total: stat.Blocks * block, Used: (stat.Blocks - stat.Bfree) * block, Available: stat.Bavail * block}, nil
}

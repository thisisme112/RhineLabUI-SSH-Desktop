package service

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"rhine.local/sshservices/internal/monitor"
	"rhine.local/sshservices/internal/native"
)

type asset struct {
	Name string `json:"name"`
	SHA  string `json:"sha256"`
	Size int64  `json:"size"`
}
type manifest struct {
	Protocol int              `json:"protocol"`
	Version  string           `json:"version"`
	Files    map[string]asset `json:"files"`
}

func (s *Service) monitorEvent(ctx context.Context, generation uint64, kind string, data any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() == nil && s.monitorGeneration == generation {
		s.event(kind, data)
	}
}
func (s *Service) monitorStatus(ctx context.Context, generation uint64, state, message string) {
	s.monitorEvent(ctx, generation, "capability", map[string]any{"service": "monitor", "state": state, "message": message})
}

func (s *Service) StartMonitor() {
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	if s.monitorCancel != nil {
		s.monitorCancel()
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.monitorCancel = cancel
	s.monitorGeneration++
	generation := s.monitorGeneration
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		err := s.monitor(ctx, generation)
		s.mu.Lock()
		current := generation == s.monitorGeneration
		s.mu.Unlock()
		if err != nil && current && ctx.Err() == nil {
			s.monitorStatus(ctx, generation, "error", err.Error())
		}
	}()
}
func (s *Service) monitor(ctx context.Context, generation uint64) error {
	s.monitorStatus(ctx, generation, "probing", "正在识别远端系统")
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	nonce := "RHINE_" + native.RandomID()
	script := "printf '" + nonce + "\\n'; uname -s; uname -m; cache=$XDG_CACHE_HOME; if [ -z \"$cache\" ]; then cache=\"$HOME/.cache\"; fi; printf '%s\\n' \"$cache\""
	output, err := s.Broker.Run(probeCtx, s.Config.SSH, "monitor", "sh -c "+native.Quote(script))
	cancel()
	if err != nil {
		return err
	}
	_, body, ok := strings.Cut(string(output), nonce+"\n")
	fields := strings.Split(strings.TrimSpace(body), "\n")
	if !ok || len(fields) != 3 || strings.TrimSpace(fields[0]) != "Linux" {
		s.monitorStatus(ctx, generation, "unsupported", "当前采集器支持 Linux；终端与 SFTP 可继续使用")
		return nil
	}
	arch := strings.TrimSpace(fields[1])
	switch arch {
	case "x86_64", "amd64":
		arch = "amd64"
	case "aarch64", "arm64":
		arch = "arm64"
	default:
		s.monitorStatus(ctx, generation, "unsupported", "暂不支持的 Linux 架构："+arch)
		return nil
	}
	cache := strings.TrimSpace(fields[2])
	if !path.IsAbs(cache) || !ValidPath(cache) || strings.ContainsAny(cache, "\r\n") {
		return errors.New("远端缓存目录无效")
	}
	manifestData, err := os.ReadFile(filepath.Join(s.Config.Resources, "manifest.json"))
	if err != nil {
		return err
	}
	var assets manifest
	if err = json.Unmarshal(manifestData, &assets); err != nil {
		return err
	}
	binary, found := assets.Files["monitor/linux/"+arch]
	if !found || assets.Protocol != 1 || len(binary.SHA) != 64 || filepath.Base(binary.Name) != binary.Name {
		return errors.New("采集器资源清单无效")
	}
	local := filepath.Join(s.Config.Resources, binary.Name)
	directory := path.Join(cache, "rhine-lab/monitor", assets.Version+"-"+binary.SHA[:16])
	remote := path.Join(directory, "agent")
	client, err := s.files()
	if err != nil {
		return err
	}
	s.monitorStatus(ctx, generation, "checking", "正在校验并准备 Linux 采集器缓存")
	if err := ctx.Err(); err != nil {
		return err
	}
	if err = s.installAgent(ctx, client, local, directory, remote, binary); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.monitorStatus(ctx, generation, "starting", "正在启动逐秒采集")
	connection, err := s.Broker.Start(ctx, s.Config.SSH, "monitor", "exec "+native.Quote(remote), false)
	if err != nil {
		return err
	}
	defer connection.Close()
	alive := make(chan struct{})
	defer close(alive)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			if _, err := io.WriteString(connection.Stdin, "{\"type\":\"heartbeat\"}\n"); err != nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-alive:
				return
			case <-ticker.C:
			}
		}
	}()
	scanner := bufio.NewScanner(connection.Stdout)
	scanner.Buffer(make([]byte, 65536), 4*1024*1024)
	ready := false
	var sequence uint64
	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.mu.Lock()
		current := s.monitorGeneration == generation
		s.mu.Unlock()
		if !current {
			return context.Canceled
		}
		var event struct {
			Type     string         `json:"type"`
			Protocol int            `json:"protocol"`
			PID      int            `json:"pid"`
			Sample   monitor.Sample `json:"sample"`
		}
		if err = json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return fmt.Errorf("无效监控数据：%w", err)
		}
		switch event.Type {
		case "hello":
			if event.Protocol != 1 {
				return errors.New("采集协议版本不匹配")
			}
			ready = true
			s.monitorEvent(ctx, generation, "capability", map[string]any{"service": "monitor", "state": "ready", "message": "实时采集中", "pid": event.PID, "cache": directory})
		case "sample":
			if !ready || event.Sample.Sequence <= sequence {
				continue
			}
			if len(event.Sample.GPUs) > 256 || len(event.Sample.Networks) > 4096 || len(event.Sample.Disks) > 4096 {
				return errors.New("监控数据超过设备数量限制")
			}
			sequence = event.Sample.Sequence
			s.monitorEvent(ctx, generation, "sample", event.Sample)
		default:
			return errors.New("未知监控数据类型")
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	diagnostics := connection.Diagnostics()
	return fmt.Errorf("采集器已退出\n%s", diagnostics)
}
func fileHash(reader io.Reader) (string, error) {
	digest := sha256.New()
	_, err := io.Copy(digest, reader)
	return hex.EncodeToString(digest.Sum(nil)), err
}
func (s *Service) installAgent(ctx context.Context, client *sftp.Client, local, directory, remote string, binary asset) error {
	file, err := os.Open(local)
	if err != nil {
		return err
	}
	defer file.Close()
	digest, err := fileHash(file)
	if err != nil {
		return err
	}
	if digest != binary.SHA {
		return errors.New("本地采集器 SHA-256 校验失败，请重新构建桌面服务")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if info, err := client.Lstat(remote); err == nil && info.Mode().IsRegular() && info.Size() == binary.Size {
		existing, err := client.Open(remote)
		if err == nil {
			digest, hashErr := fileHash(existing)
			existing.Close()
			if hashErr == nil && digest == binary.SHA {
				return client.Chmod(remote, 0700)
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := client.MkdirAll(directory); err != nil {
		return err
	}
	if err := client.Chmod(directory, 0700); err != nil {
		return err
	}
	temporary := remote + "." + native.RandomID() + ".part"
	target, err := client.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		target.Close()
		if !committed {
			_ = client.Remove(temporary)
		}
	}()
	_, err = io.Copy(target, &contextReader{ctx: ctx, reader: file})
	if closeErr := target.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := client.Chmod(temporary, 0700); err != nil {
		return err
	}
	check, err := client.Open(temporary)
	if err != nil {
		return err
	}
	digest, err = fileHash(check)
	check.Close()
	if err != nil {
		return err
	}
	if digest != binary.SHA {
		return errors.New("上传后的采集器 SHA-256 校验失败")
	}
	if _, err := client.Lstat(remote); err == nil {
		if _, ok := client.HasExtension("posix-rename@openssh.com"); ok {
			err = client.PosixRename(temporary, remote)
		} else {
			backup := remote + "." + native.RandomID() + ".bak"
			if err = client.Rename(remote, backup); err == nil {
				err = client.Rename(temporary, remote)
				if err != nil {
					_ = client.Rename(backup, remote)
				} else {
					_ = client.Remove(backup)
				}
			}
		}
		if err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	} else if err = client.Rename(temporary, remote); err != nil {
		return err
	}
	committed = true
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

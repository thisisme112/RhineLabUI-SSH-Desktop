package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"rhine.local/sshservices/internal/monitor"
)

type gpuFeed struct {
	sync.Mutex
	devices []monitor.GPU
	at      int64
	state   string
	err     string
}

func (feed *gpuFeed) set(state string, err error) {
	feed.Lock()
	defer feed.Unlock()
	feed.state = state
	feed.err = ""
	if err != nil {
		feed.err = err.Error()
	}
}
func (feed *gpuFeed) run(ctx context.Context) {
	file, err := exec.LookPath("nvidia-smi")
	if err != nil {
		feed.set("unavailable", fmt.Errorf("nvidia-smi 不可用"))
		return
	}
	for ctx.Err() == nil {
		err := feed.read(ctx, file)
		if ctx.Err() != nil {
			return
		}
		feed.set("error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}
func (feed *gpuFeed) read(parent context.Context, file string) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	cmd := exec.CommandContext(ctx, file, "-q", "-x", "-l", "1")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	// NVIDIA's stderr is bounded independently of the XML stream.
	var stderr boundedBuffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		return err
	}
	defer func() { cancel(); _ = cmd.Wait() }()
	last := atomic.Int64{}
	clock := time.Now()
	last.Store(0)
	go func() {
		timer := time.NewTicker(time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				if time.Since(clock).Milliseconds()-last.Load() > 3500 {
					cancel()
					return
				}
			}
		}
	}()
	buffer := make([]byte, 0, 65536)
	chunk := make([]byte, 32768)
	for {
		n, err := stdout.Read(chunk)
		if n > 0 {
			buffer = append(buffer, chunk[:n]...)
		}
		if len(buffer) > 4*1024*1024 {
			return fmt.Errorf("NVIDIA XML 超过大小限制")
		}
		for {
			start := bytes.Index(buffer, []byte("<nvidia_smi_log"))
			end := bytes.Index(buffer, []byte("</nvidia_smi_log>"))
			if start < 0 || end < start {
				break
			}
			end += len("</nvidia_smi_log>")
			devices, parseErr := monitor.ParseGPU(buffer[start:end])
			if parseErr != nil {
				return parseErr
			}
			last.Store(time.Since(clock).Milliseconds())
			feed.Lock()
			feed.devices, feed.at, feed.state, feed.err = devices, time.Now().UnixMilli(), "live", ""
			if len(devices) == 0 {
				feed.state = "unavailable"
				feed.err = "未发现 NVIDIA 设备"
			}
			feed.Unlock()
			buffer = append(buffer[:0], buffer[end:]...)
		}
		if err != nil {
			if parent.Err() != nil {
				return parent.Err()
			}
			message := strings.TrimSpace(stderr.String())
			if message == "" {
				message = "NVIDIA 采样中断或超过 3.5 秒未更新"
			}
			return fmt.Errorf("%s", message)
		}
	}
}

type boundedBuffer struct {
	sync.Mutex
	data []byte
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	b.data = append(b.data, p...)
	if len(b.data) > 4096 {
		b.data = b.data[len(b.data)-4096:]
	}
	return len(p), nil
}
func (b *boundedBuffer) String() string { b.Lock(); defer b.Unlock(); return string(b.data) }

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("rhine-monitor 1.0.0 protocol=1")
		return
	}
	if runtime.GOOS != "linux" {
		fmt.Fprintln(os.Stderr, "Linux collector required")
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	run(ctx, os.Stdin, os.Stdout, runOptions{root: "/", heartbeatTimeout: 15 * time.Second, interval: time.Second, gpu: (*gpuFeed).run})
}

type runOptions struct {
	root             string
	heartbeatTimeout time.Duration
	interval         time.Duration
	gpu              func(*gpuFeed, context.Context)
}

// I/O may stop draining when the SSH channel disappears. Cancellation must
// still return from run and reap the NVIDIA child without waiting for stdout.
func run(parent context.Context, input io.Reader, output io.Writer, options runOptions) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	heartbeat := atomic.Int64{}
	clock := time.Now()
	go func() {
		scanner := bufio.NewScanner(io.LimitReader(input, 1<<40))
		scanner.Buffer(make([]byte, 4096), 4096)
		for scanner.Scan() {
			var message struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(scanner.Bytes(), &message) != nil {
				cancel()
				return
			}
			if message.Type == "stop" {
				cancel()
				return
			}
			if message.Type == "heartbeat" {
				heartbeat.Store(time.Since(clock).Milliseconds())
			}
		}
		cancel()
	}()
	// The heartbeat runs independently of statfs and stdout. An unavailable
	// network filesystem or a blocked SSH pipe cannot keep the agent alive.
	go func() {
		ticker := time.NewTicker(min(time.Second, options.heartbeatTimeout/4))
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if time.Since(clock).Milliseconds()-heartbeat.Load() >= options.heartbeatTimeout.Milliseconds() {
					cancel()
					return
				}
			}
		}
	}()
	frames := make(chan any, 1)
	go func() {
		encoder := json.NewEncoder(output)
		if encoder.Encode(map[string]any{"type": "hello", "protocol": 1, "version": "1.0.0", "pid": os.Getpid(), "arch": runtime.GOARCH}) != nil {
			cancel()
			return
		}
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-frames:
				if encoder.Encode(frame) != nil {
					cancel()
					return
				}
			}
		}
	}()
	feed := &gpuFeed{state: "starting", devices: []monitor.GPU{}}
	gpuDone := make(chan struct{})
	go func() { defer close(gpuDone); options.gpu(feed, ctx) }()
	defer func() { cancel(); <-gpuDone }()
	go func() {
		collector := monitor.NewCollector(options.root)
		ticker := time.NewTicker(options.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				sample := collector.Collect(now)
				feed.Lock()
				sample.GPUs, sample.GPUAt, sample.GPUState, sample.GPUError = feed.devices, feed.at, feed.state, feed.err
				feed.Unlock()
				frame := map[string]any{"type": "sample", "sample": sample}
				select {
				case frames <- frame:
				default:
					select {
					case <-frames:
					default:
					}
					select {
					case frames <- frame:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()
	<-ctx.Done()
}

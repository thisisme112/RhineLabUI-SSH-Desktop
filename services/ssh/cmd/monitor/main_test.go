package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Execute a real child without depending on NVIDIA hardware or a Linux host.
// Production read() still supplies and exercises the actual nvidia-smi flags.
func TestMain(m *testing.M) {
	if os.Getenv("RHINE_GPU_TEST_CHILD") == "1" {
		if strings.Join(os.Args[1:], " ") != "-q -x -l 1" {
			os.Exit(2)
		}
		fmt.Fprint(os.Stdout, "<?xml version=\"1.0\"?><nvidia_smi_log version=\"fixture\"><gpu><uuid>GPU-child</uuid>")
		time.Sleep(25 * time.Millisecond)
		fmt.Fprint(os.Stdout, "<product_name>Child fixture</product_name><minor_number>4</minor_number><utilization><gpu_util>17 %</gpu_util></utilization></gpu></nvidia_smi_log>\n")
		time.Sleep(time.Hour)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func waitDone(t *testing.T, done <-chan struct{}, timeout time.Duration) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatal("collector did not shut down")
	}
}

func optionsFor(t *testing.T, stopped chan struct{}) runOptions {
	t.Helper()
	return runOptions{
		root: t.TempDir(), heartbeatTimeout: 200 * time.Millisecond, interval: 20 * time.Millisecond,
		gpu: func(_ *gpuFeed, ctx context.Context) { <-ctx.Done(); close(stopped) },
	}
}

func TestControlAndInputClosureStopCollector(t *testing.T) {
	for name, input := range map[string]string{
		"stop": "{\"type\":\"stop\"}\n", "eof": "", "invalid-json": "bad\n",
	} {
		t.Run(name, func(t *testing.T) {
			stopped, done := make(chan struct{}), make(chan struct{})
			options := optionsFor(t, stopped)
			go func() { defer close(done); run(context.Background(), strings.NewReader(input), io.Discard, options) }()
			waitDone(t, done, time.Second)
			select {
			case <-stopped:
			default:
				t.Fatal("run returned without waiting for GPU shutdown")
			}
		})
	}
}

type frameCounter struct{ samples atomic.Int64 }

func (c *frameCounter) Write(p []byte) (int, error) {
	var frame struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(p, &frame); err != nil {
		return 0, err
	}
	if frame.Type == "sample" {
		c.samples.Add(1)
	}
	return len(p), nil
}

func TestHeartbeatExtendsLifeAndSamplesContinue(t *testing.T) {
	input, heartbeats := io.Pipe()
	defer input.Close()
	defer heartbeats.Close()
	stopped, done := make(chan struct{}), make(chan struct{})
	options := optionsFor(t, stopped)
	output := &frameCounter{}
	go func() { defer close(done); run(context.Background(), input, output, options) }()
	for i := 0; i < 8; i++ {
		if _, err := io.WriteString(heartbeats, "{\"type\":\"heartbeat\"}\n"); err != nil {
			t.Fatal(err)
		}
		select {
		case <-done:
			t.Fatal("heartbeat did not keep collector alive")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if output.samples.Load() < 5 {
		t.Fatal("collector did not continue sampling")
	}
	// Keep stdin open: only a missing heartbeat can end this run.
	waitDone(t, done, time.Second)
	waitDone(t, stopped, time.Second)
}

func TestBlockedOutputDoesNotPreventHeartbeatShutdown(t *testing.T) {
	input, heartbeats := io.Pipe()
	outputReader, output := io.Pipe()
	defer input.Close()
	defer heartbeats.Close()
	defer outputReader.Close()
	defer output.Close()
	stopped, done := make(chan struct{}), make(chan struct{})
	options := optionsFor(t, stopped)
	go func() { defer close(done); run(context.Background(), input, output, options) }()
	// No one consumes stdout, including the initial hello frame.
	waitDone(t, done, time.Second)
	waitDone(t, stopped, time.Second)
}

func TestNvidiaChildSplitXMLWatchdogAndCancellation(t *testing.T) {
	t.Setenv("RHINE_GPU_TEST_CHILD", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, watchdog := range []bool{false, true} {
		t.Run(fmt.Sprintf("watchdog-%t", watchdog), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			feed := &gpuFeed{}
			result := make(chan error, 1)
			go func() { result <- feed.read(ctx, executable) }()
			deadline := time.Now().Add(2 * time.Second)
			ready := false
			for time.Now().Before(deadline) {
				feed.Lock()
				ready = feed.state == "live" && len(feed.devices) == 1 && feed.devices[0].Index == 4 && *feed.devices[0].Utilization == 17
				feed.Unlock()
				if ready {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !ready {
				t.Fatal("split child XML was not sampled")
			}
			if !watchdog {
				cancel()
			}
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("stalled child should return an error")
				}
			case <-time.After(6 * time.Second):
				t.Fatal("NVIDIA child not killed and waited after cancellation/watchdog")
			}
		})
	}
}

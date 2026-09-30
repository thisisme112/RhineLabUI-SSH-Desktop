package main

// -showcase: the same isolated fixture dressed for a product demonstration.
// Each login name stands for a host (see showcaseHosts); the shell answers a
// few commands with a prompt, and the collector streams moving but made-up
// telemetry for a multi-GPU machine. Nothing here reads the real machine.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"rhine.local/sshservices/internal/monitor"
)

type showcaseHost struct {
	name, gpu string
	gpus      int
	vram      float64 // GiB per GPU
	cores     int
	memory    uint64 // GiB
	phase     float64
}

var showcaseHosts = map[string]showcaseHost{
	"atlas":  {"atlas-a100", "NVIDIA A100-SXM4-80GB", 4, 80, 128, 1024, 0},
	"orion":  {"orion-render", "NVIDIA RTX 6000 Ada Generation", 2, 48, 64, 512, 1.3},
	"vela":   {"vela-edge", "NVIDIA L4", 1, 24, 32, 128, 2.1},
	"lyra":   {"lyra-archive", "", 0, 0, 48, 256, 0.7},
	"carina": {"carina-lab", "NVIDIA GeForce RTX 4090", 2, 24, 24, 192, 2.8},
}

func hostFor(user string) showcaseHost {
	if host, ok := showcaseHosts[user]; ok {
		return host
	}
	return showcaseHost{"rhine-node", "NVIDIA L40S", 2, 48, 64, 256, 0.4}
}

func showcaseShell(channel ssh.Channel, user string) {
	defer channel.Close()
	host := hostFor(user)
	prompt := fmt.Sprintf("\x1b[1;36m%s@%s\x1b[0m:\x1b[1;34m~\x1b[0m$ ", user, host.name)
	gpuLine := "no accelerator"
	if host.gpus > 0 {
		gpuLine = fmt.Sprintf("%d × %s", host.gpus, host.gpu)
	}
	_, _ = fmt.Fprintf(channel, "Welcome to Rhine Lab compute node \x1b[1m%s\x1b[0m (Ubuntu 24.04 LTS x86_64)\r\n\r\n  CPU     %d cores\r\n  Memory  %d GiB\r\n  GPU     %s\r\n\r\nLast login: %s from 10.20.0.14\r\n%s",
		host.name, host.cores, host.memory, gpuLine, time.Now().Add(-26*time.Hour).Format("Mon Jan  2 15:04:05 2006"), prompt)
	reader := bufio.NewReader(channel)
	line := []byte{}
	for {
		b, err := reader.ReadByte()
		if err != nil {
			return
		}
		switch b {
		case '\r', '\n':
			_, _ = io.WriteString(channel, "\r\n")
			command := strings.TrimSpace(string(line))
			line = line[:0]
			if command == "exit" || command == "logout" {
				_, _ = io.WriteString(channel, "logout\r\n")
				_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
				return
			}
			_, _ = io.WriteString(channel, showcaseCommand(command, host))
			_, _ = io.WriteString(channel, prompt)
		case 0x7f, 0x08:
			if len(line) > 0 {
				line = line[:len(line)-1]
				_, _ = io.WriteString(channel, "\b \b")
			}
		case 0x03:
			line = line[:0]
			_, _ = io.WriteString(channel, "^C\r\n"+prompt)
		default:
			if b >= 0x20 {
				line = append(line, b)
				_, _ = channel.Write([]byte{b})
			}
		}
	}
}

func showcaseCommand(command string, host showcaseHost) string {
	switch {
	case command == "":
		return ""
	case command == "ls" || strings.HasPrefix(command, "ls "):
		return "\x1b[1;34mcheckpoints\x1b[0m  \x1b[1;34mdatasets\x1b[0m  \x1b[1;34mnotebooks\x1b[0m  \x1b[1;34mrenders\x1b[0m  \x1b[1;32mtrain.sh\x1b[0m  config.yaml  README.md  metrics.csv\r\n"
	case command == "uptime":
		return fmt.Sprintf(" %s up 41 days,  6:12,  2 users,  load average: 3.42, 3.10, 2.87\r\n", time.Now().Format("15:04:05"))
	case command == "nvidia-smi":
		if host.gpus == 0 {
			return "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\r\n"
		}
		var out strings.Builder
		out.WriteString("+-----------------------------------------------------------------------------+\r\n")
		out.WriteString("| NVIDIA-SMI 560.35.03    Driver Version: 560.35.03    CUDA Version: 12.6      |\r\n")
		out.WriteString("|-------------------------------+----------------------+----------------------+\r\n")
		out.WriteString("| GPU  Name                     | Memory-Usage         | GPU-Util  Temp  Pwr  |\r\n")
		out.WriteString("|===============================+======================+======================|\r\n")
		now := float64(time.Now().UnixMilli()) / 1000
		for i := 0; i < host.gpus; i++ {
			util, used := gpuLoad(host, i, now)
			name := host.gpu
			if len(name) > 24 {
				name = name[:24]
			}
			out.WriteString(fmt.Sprintf("| %3d  %-24s | %6.0fMiB / %6.0fMiB | %5.0f%%   %3.0fC  %3.0fW |\r\n", i, name, used*1024, host.vram*1024, util, 48+util*.3, 90+util*2.6))
		}
		out.WriteString("+-----------------------------------------------------------------------------+\r\n")
		return out.String()
	case command == "whoami":
		return "rhine\r\n"
	case command == "hostname":
		return host.name + "\r\n"
	default:
		name := strings.Fields(command)[0]
		return fmt.Sprintf("%s: command not found\r\n", name)
	}
}

// gpuLoad: utilisation (%) and memory in use (GiB) for one GPU at a time.
func gpuLoad(host showcaseHost, index int, now float64) (float64, float64) {
	phase := host.phase + float64(index)*1.7
	util := 58 + 30*math.Sin(now*.45+phase) + 8*math.Sin(now*1.9+phase*2)
	util = math.Max(3, math.Min(99, util))
	used := host.vram * (.46 + .3*math.Sin(now*.12+phase) + .06*math.Sin(now*.7+phase))
	return util, math.Max(1, math.Min(host.vram*.97, used))
}

func showcaseMonitor(parent context.Context, channel ssh.Channel, emit func(any), user string) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	emit(map[string]any{"event": "monitor-started"})
	defer emit(map[string]any{"event": "monitor-stopped"})
	go func() {
		scanner := bufio.NewScanner(channel)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "stop") {
				break
			}
		}
		cancel()
	}()
	host := hostFor(user)
	encoder := json.NewEncoder(channel)
	if encoder.Encode(map[string]any{"type": "hello", "protocol": 1, "version": "showcase", "pid": 4242}) != nil {
		return
	}
	ptr := func(v float64) *float64 { return &v }
	const gib = float64(1 << 30)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var sequence uint64
	for {
		now := time.Now()
		t := float64(now.UnixMilli()) / 1000
		sequence++
		cpu := 42 + 22*math.Sin(t*.3+host.phase) + 9*math.Sin(t*1.3)
		memUsed := uint64(float64(host.memory) * (.52 + .08*math.Sin(t*.1+host.phase)) * gib)
		gpus := []monitor.GPU{}
		for i := 0; i < host.gpus; i++ {
			util, used := gpuLoad(host, i, t)
			processes := []monitor.GPUProcess{{PID: 31800 + i*7, Name: "python train.py --shard " + fmt.Sprint(i), Type: "C", Memory: ptr(used * gib * .92), GPU: fmt.Sprintf("GPU-%s-%d", host.name, i)}}
			if i%2 == 1 {
				processes = append(processes, monitor.GPUProcess{PID: 29011, Name: "blender --background", Type: "C", Memory: ptr(used * gib * .06), GPU: fmt.Sprintf("GPU-%s-%d", host.name, i)})
			}
			gpus = append(gpus, monitor.GPU{UUID: fmt.Sprintf("GPU-%s-%d", host.name, i), Index: i, Name: host.gpu,
				Utilization: ptr(math.Round(util)), MemoryUsed: ptr(used * gib), MemoryTotal: ptr(host.vram * gib),
				Temperature: ptr(math.Round(48 + util*.3)), Power: ptr(math.Round(90 + util*2.6)), PowerLimit: ptr(400), Fan: ptr(math.Round(30 + util*.4)),
				Processes: processes})
		}
		gpuState := "live"
		if host.gpus == 0 {
			gpuState = "unavailable"
		}
		read, write := 180e6+120e6*math.Sin(t*.6), 60e6+40e6*math.Sin(t*.9+1)
		receive, send := 850e6+300e6*math.Sin(t*.5), 240e6+90e6*math.Sin(t*.8+2)
		sample := monitor.Sample{Sequence: sequence, Timestamp: now.UnixMilli(), Hostname: host.name, Uptime: 41*86400 + 6*3600,
			CPU:    &monitor.CPU{Usage: ptr(math.Round(math.Max(2, math.Min(98, cpu)))), Cores: host.cores, Load: []float64{3.42, 3.10, 2.87}},
			Memory: &monitor.Memory{Total: host.memory << 30, Used: memUsed, Available: host.memory<<30 - memUsed, SwapTotal: 16 << 30, SwapUsed: 1 << 29},
			Disks: []monitor.Disk{
				{Mount: "/", Device: "/dev/nvme0n1p2", Total: 1800 << 30, Used: 612 << 30, Available: 1188 << 30},
				{Mount: "/data", Device: "/dev/md0", Total: 30 << 40, Used: 19 << 40, Available: 11 << 40},
				{Mount: "/scratch", Device: "/dev/nvme1n1", Total: 7 << 40, Used: 5 << 40, Available: 2 << 40},
			},
			DiskIO:   monitor.Rates{Read: ptr(read), Write: ptr(write)},
			Networks: []monitor.Network{{Name: "eth0", Receive: ptr(receive / 8), Send: ptr(send / 8)}, {Name: "ib0", Receive: ptr(receive), Send: ptr(send)}},
			GPUs:     gpus, GPUAt: now.UnixMilli(), GPUState: gpuState}
		if encoder.Encode(map[string]any{"type": "sample", "sample": sample}) != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

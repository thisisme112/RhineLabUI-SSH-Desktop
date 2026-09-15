package monitor

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type CPU struct {
	Usage *float64  `json:"usage"`
	Cores int       `json:"cores"`
	Load  []float64 `json:"load"`
}
type Memory struct {
	Total     uint64 `json:"total"`
	Used      uint64 `json:"used"`
	Available uint64 `json:"available"`
	SwapTotal uint64 `json:"swapTotal"`
	SwapUsed  uint64 `json:"swapUsed"`
}
type Disk struct {
	Mount     string `json:"mount"`
	Device    string `json:"device"`
	Total     uint64 `json:"total"`
	Used      uint64 `json:"used"`
	Available uint64 `json:"available"`
}
type Rates struct {
	Read  *float64 `json:"read"`
	Write *float64 `json:"write"`
}
type Network struct {
	Name    string   `json:"name"`
	Receive *float64 `json:"receive"`
	Send    *float64 `json:"send"`
}
type Sample struct {
	Sequence  uint64    `json:"sequence"`
	Timestamp int64     `json:"timestamp"`
	Hostname  string    `json:"hostname"`
	Uptime    float64   `json:"uptime"`
	CPU       *CPU      `json:"cpu"`
	Memory    *Memory   `json:"memory"`
	Disks     []Disk    `json:"disks"`
	DiskIO    Rates     `json:"diskIO"`
	Networks  []Network `json:"networks"`
	GPUs      []GPU     `json:"gpus"`
	GPUAt     int64     `json:"gpuAt"`
	GPUState  string    `json:"gpuState"`
	GPUError  string    `json:"gpuError,omitempty"`
	Errors    []string  `json:"errors,omitempty"`
}
type counters struct{ first, second uint64 }
type Collector struct {
	Root     string
	sequence uint64
	cpuAt    time.Time
	netAt    time.Time
	ioAt     time.Time
	cpu      counters
	net      map[string]counters
	io       counters
	disks    []Disk
	diskAt   time.Time
	diskMu   sync.Mutex
	diskBusy bool
	diskErr  error
}

func NewCollector(root string) *Collector {
	return &Collector{Root: root, net: make(map[string]counters), disks: []Disk{}}
}
func (c *Collector) read(name string) (string, error) {
	data, err := os.ReadFile(filepath.Join(c.Root, filepath.FromSlash(name)))
	return string(data), err
}
func number(s string) uint64     { n, _ := strconv.ParseUint(s, 10, 64); return n }
func numeric(s string) float64   { n, _ := strconv.ParseFloat(s, 64); return n }
func pointer(n float64) *float64 { return &n }
func delta(current, previous uint64, seconds float64) *float64 {
	if seconds <= 0 || current < previous {
		return nil
	}
	return pointer(float64(current-previous) / seconds)
}
func elapsed(now, before time.Time) float64 {
	if before.IsZero() {
		return 0
	}
	return now.Sub(before).Seconds()
}

func ParseCPU(text string) (total, idle uint64, cores int, err error) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		if fields[0] == "cpu" {
			// guest/guest_nice are already included in user/nice.
			for index, value := range fields[1:] {
				if index >= 8 {
					break
				}
				total += number(value)
			}
			idle = number(fields[4])
			if len(fields) > 5 {
				idle += number(fields[5])
			}
		} else if strings.HasPrefix(fields[0], "cpu") {
			cores++
		}
	}
	if total == 0 {
		err = fmt.Errorf("CPU counters unavailable")
	}
	return
}

func ParseMemory(text string) (*Memory, error) {
	fields := make(map[string]uint64)
	for _, line := range strings.Split(text, "\n") {
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			fields[strings.TrimSuffix(parts[0], ":")] = number(parts[1]) * 1024
		}
	}
	total := fields["MemTotal"]
	if total == 0 {
		return nil, fmt.Errorf("memory counters unavailable")
	}
	available, ok := fields["MemAvailable"]
	if !ok {
		available = fields["MemFree"] + fields["Buffers"] + fields["Cached"] + fields["SReclaimable"]
	}
	if available > total {
		available = total
	}
	swapFree := fields["SwapFree"]
	if swapFree > fields["SwapTotal"] {
		swapFree = fields["SwapTotal"]
	}
	return &Memory{Total: total, Available: available, Used: total - available, SwapTotal: fields["SwapTotal"], SwapUsed: fields["SwapTotal"] - swapFree}, nil
}

func ParseNetwork(text string) map[string]counters {
	result := make(map[string]counters)
	for _, line := range strings.Split(text, "\n") {
		name, body, found := strings.Cut(line, ":")
		fields := strings.Fields(body)
		name = strings.TrimSpace(name)
		if found && name != "lo" && len(fields) >= 16 {
			result[name] = counters{number(fields[0]), number(fields[8])}
		}
	}
	return result
}

func (c *Collector) diskCounters(text string) counters {
	var result counters
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 14 {
			continue
		}
		name := fields[2]
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") {
			continue
		}
		// Whole devices only; partitions would count the same IO a second time.
		if _, err := os.Stat(filepath.Join(c.Root, "sys/block", name)); err != nil {
			continue
		}
		result.first += number(fields[5]) * 512
		result.second += number(fields[9]) * 512
	}
	return result
}

func (c *Collector) collectDisks() ([]Disk, error) {
	mounts, err := c.read("proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	result := []Disk{}
	seen := make(map[string]bool)
	unescape := strings.NewReplacer("\\040", " ", "\\011", "\t", "\\012", "\n", "\\134", "\\")
	scanner := bufio.NewScanner(strings.NewReader(mounts))
	for scanner.Scan() {
		left, right, ok := strings.Cut(scanner.Text(), " - ")
		pre, post := strings.Fields(left), strings.Fields(right)
		if !ok || len(pre) < 5 || len(post) < 2 {
			continue
		}
		mount := unescape.Replace(pre[4])
		if mount != "/" && (strings.HasPrefix(mount, "/proc") || strings.HasPrefix(mount, "/sys") || strings.HasPrefix(mount, "/dev") || strings.HasPrefix(mount, "/run")) {
			continue
		}
		switch post[0] {
		case "proc", "sysfs", "devpts", "cgroup", "cgroup2", "securityfs", "debugfs", "tracefs", "mqueue", "pstore", "hugetlbfs", "autofs":
			continue
		}
		key := pre[2] + ":" + pre[3]
		if seen[key] {
			continue
		}
		disk, err := diskUsage(filepath.Join(c.Root, filepath.FromSlash(mount)))
		if err != nil || disk.Total == 0 {
			continue
		}
		seen[key] = true
		disk.Mount, disk.Device = mount, unescape.Replace(post[1])
		result = append(result, disk)
	}
	return result, scanner.Err()
}

func (c *Collector) Collect(now time.Time) Sample {
	c.sequence++
	host, _ := os.Hostname()
	sample := Sample{Sequence: c.sequence, Timestamp: now.UnixMilli(), Hostname: host, Networks: []Network{}, GPUs: []GPU{}, GPUState: "starting"}
	if text, err := c.read("proc/stat"); err == nil {
		total, idle, cores, err := ParseCPU(text)
		if err == nil {
			var usage *float64
			if elapsed(now, c.cpuAt) > 0 && total > c.cpu.first && idle >= c.cpu.second && idle-c.cpu.second <= total-c.cpu.first {
				usage = pointer(100 * (1 - float64(idle-c.cpu.second)/float64(total-c.cpu.first)))
			}
			sample.CPU = &CPU{Usage: usage, Cores: cores, Load: []float64{}}
			if load, err := c.read("proc/loadavg"); err == nil {
				fields := strings.Fields(load)
				for i := 0; i < 3 && i < len(fields); i++ {
					sample.CPU.Load = append(sample.CPU.Load, numeric(fields[i]))
				}
			}
			c.cpu = counters{total, idle}
			c.cpuAt = now
		} else {
			sample.Errors = append(sample.Errors, err.Error())
		}
	} else {
		sample.Errors = append(sample.Errors, "CPU: "+err.Error())
	}
	if text, err := c.read("proc/meminfo"); err == nil {
		sample.Memory, err = ParseMemory(text)
		if err != nil {
			sample.Errors = append(sample.Errors, "memory: "+err.Error())
		}
	} else {
		sample.Errors = append(sample.Errors, "memory: "+err.Error())
	}
	if text, err := c.read("proc/uptime"); err == nil {
		if fields := strings.Fields(text); len(fields) > 0 {
			sample.Uptime = numeric(fields[0])
		}
	}
	if text, err := c.read("proc/net/dev"); err == nil {
		current := ParseNetwork(text)
		seconds := elapsed(now, c.netAt)
		for name, counters := range current {
			var in, out *float64
			if previous, ok := c.net[name]; ok {
				in, out = delta(counters.first, previous.first, seconds), delta(counters.second, previous.second, seconds)
			}
			sample.Networks = append(sample.Networks, Network{Name: name, Receive: in, Send: out})
		}
		c.net = current
		c.netAt = now
		sort.Slice(sample.Networks, func(i, j int) bool { return sample.Networks[i].Name < sample.Networks[j].Name })
	} else {
		sample.Errors = append(sample.Errors, "network: "+err.Error())
	}
	if text, err := c.read("proc/diskstats"); err == nil {
		current := c.diskCounters(text)
		seconds := elapsed(now, c.ioAt)
		sample.DiskIO = Rates{Read: delta(current.first, c.io.first, seconds), Write: delta(current.second, c.io.second, seconds)}
		c.io = current
		c.ioAt = now
	} else {
		sample.Errors = append(sample.Errors, "disk IO: "+err.Error())
	}
	c.diskMu.Lock()
	sample.Disks = c.disks
	if c.diskErr != nil {
		sample.Errors = append(sample.Errors, "disk: "+c.diskErr.Error())
	}
	if !c.diskBusy && now.Sub(c.diskAt) >= 10*time.Second {
		c.diskBusy, c.diskAt = true, now
		// A stalled statfs on a network mount must not stall CPU/GPU sampling.
		go func() {
			disks, err := c.collectDisks()
			c.diskMu.Lock()
			defer c.diskMu.Unlock()
			c.diskBusy, c.diskErr = false, err
			if err == nil {
				c.disks = disks
			}
		}()
	}
	c.diskMu.Unlock()
	return sample
}

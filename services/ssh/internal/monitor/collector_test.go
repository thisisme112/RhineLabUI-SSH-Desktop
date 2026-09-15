package monitor

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCounterAndMemoryParsing(t *testing.T) {
	total, idle, cores, err := ParseCPU("cpu  100 0 20 800 30 10 20 20 7 3\ncpu0 1 2 3 4\ncpu1 1 2 3 4\n")
	if err != nil || total != 1000 || idle != 830 || cores != 2 {
		t.Fatalf("CPU: %d %d %d %v", total, idle, cores, err)
	}
	if delta(1, 2, 1) != nil || delta(2, 1, 0) != nil {
		t.Fatal("counter resets and first samples must be unavailable")
	}
	memory, err := ParseMemory("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 20 kB\nCached: 200 kB\nSReclaimable: 30 kB\nSwapTotal: 400 kB\nSwapFree: 500 kB\n")
	if err != nil || memory.Used != 650*1024 || memory.SwapUsed != 0 {
		t.Fatalf("memory fallback: %+v %v", memory, err)
	}
	if _, err := ParseMemory("MemTotal: 0 kB"); err == nil {
		t.Fatal("missing memory must not be reported as zero usage")
	}
}

func TestRatesSurviveReadGapsAndCounterResets(t *testing.T) {
	root := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		file := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/stat", "cpu 100 0 0 100 0 0 0 0\ncpu0 100 0 0 100\n")
	write("proc/meminfo", "MemTotal: 1024 kB\nMemAvailable: 512 kB\n")
	write("proc/net/dev", "eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n")
	write("proc/diskstats", "8 0 sda 0 0 10 0 0 0 20 0 0 0 0\n")
	if err := os.MkdirAll(filepath.Join(root, "sys/block/sda"), 0755); err != nil {
		t.Fatal(err)
	}
	c := NewCollector(root)
	// Keep capacities out of this proc-counter test.
	now := time.Now()
	c.diskAt = now
	first := c.Collect(now)
	if first.CPU.Usage != nil || first.Networks[0].Receive != nil || first.DiskIO.Read != nil {
		t.Fatal("first sample cannot contain rates")
	}
	if err := os.Remove(filepath.Join(root, "proc/net/dev")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "proc/diskstats")); err != nil {
		t.Fatal(err)
	}
	c.Collect(now.Add(time.Second))
	write("proc/net/dev", "eth0: 3000 0 0 0 0 0 0 0 6000 0 0 0 0 0 0 0\n")
	write("proc/diskstats", "8 0 sda 0 0 14 0 0 0 28 0 0 0 0\n")
	write("proc/stat", "cpu 150 0 0 150 0 0 0 0\ncpu0 150 0 0 150\n")
	next := c.Collect(now.Add(2 * time.Second))
	if math.Abs(*next.Networks[0].Receive-1000) > .01 || *next.DiskIO.Read != 1024 || *next.CPU.Usage != 50 {
		t.Fatalf("rates use time since the last successful read: %+v", next)
	}
	write("proc/net/dev", "eth0: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n")
	if c.Collect(now.Add(3 * time.Second)).Networks[0].Receive != nil {
		t.Fatal("reset counter must create a gap, not a spike")
	}
}

func TestNvidiaVersionsAndUnavailableMetrics(t *testing.T) {
	xml := `<nvidia_smi_log><gpu><product_name>Fixture A &amp; B</product_name><uuid>GPU-one</uuid><minor_number>2</minor_number><utilization><gpu_util>75 %</gpu_util></utilization><fb_memory_usage><used>1024 MiB</used><total>24 GiB</total></fb_memory_usage><temperature><gpu_temp>64 C</gpu_temp></temperature><power_readings><power_draw>180 W</power_draw><power_limit>300 W</power_limit></power_readings><processes><process_info><pid>42</pid><process_name>/usr/bin/python&lt;test&gt;</process_name><type>C</type><used_memory>1024 MiB</used_memory></process_info></processes></gpu><gpu><product_name>Fixture New</product_name><uuid>GPU-two</uuid><utilization><gpu_util>N/A</gpu_util></utilization><fb_memory_usage><used>N/A</used><total>49140 MiB</total></fb_memory_usage><gpu_power_readings><instant_power_draw>51.20 W</instant_power_draw><current_power_limit>285 W</current_power_limit></gpu_power_readings></gpu></nvidia_smi_log>`
	gpus, err := ParseGPU([]byte(xml))
	if err != nil || len(gpus) != 2 {
		t.Fatalf("%v %+v", err, gpus)
	}
	if gpus[0].Index != 2 || *gpus[0].MemoryUsed != 1073741824 || *gpus[0].MemoryTotal != 24*1073741824 || *gpus[0].Power != 180 || gpus[0].Processes[0].Name != "/usr/bin/python<test>" {
		t.Fatalf("old XML: %+v", gpus[0])
	}
	if gpus[1].Utilization != nil || gpus[1].MemoryUsed != nil || *gpus[1].Power != 51.2 || *gpus[1].PowerLimit != 285 {
		t.Fatalf("new XML: %+v", gpus[1])
	}
	if _, err := ParseGPU([]byte("<nvidia_smi_log><broken>")); err == nil {
		t.Fatal("invalid XML accepted")
	}
	if metric("NaN") != nil || metric("-1 W") != nil || metric("N/A") != nil {
		t.Fatal("invalid metric must remain unavailable")
	}
}

package monitor

import (
	"encoding/xml"
	"fmt"
	"math"
	"strconv"
	"strings"
)

type GPUProcess struct {
	PID    int      `json:"pid"`
	Name   string   `json:"name"`
	Type   string   `json:"type"`
	Memory *float64 `json:"memory"`
	GPU    string   `json:"gpu"`
}
type GPU struct {
	UUID        string       `json:"uuid"`
	Index       int          `json:"index"`
	Name        string       `json:"name"`
	Utilization *float64     `json:"utilization"`
	MemoryUsed  *float64     `json:"memoryUsed"`
	MemoryTotal *float64     `json:"memoryTotal"`
	Temperature *float64     `json:"temperature"`
	Power       *float64     `json:"power"`
	PowerLimit  *float64     `json:"powerLimit"`
	Fan         *float64     `json:"fan"`
	Processes   []GPUProcess `json:"processes"`
}

type nvidiaLog struct {
	XMLName xml.Name `xml:"nvidia_smi_log"`
	GPUs    []struct {
		UUID        string `xml:"uuid"`
		Name        string `xml:"product_name"`
		Minor       string `xml:"minor_number"`
		Utilization string `xml:"utilization>gpu_util"`
		Used        string `xml:"fb_memory_usage>used"`
		Total       string `xml:"fb_memory_usage>total"`
		Temperature string `xml:"temperature>gpu_temp"`
		Fan         string `xml:"fan_speed"`
		Power       struct {
			Draw    string `xml:"power_draw"`
			Limit   string `xml:"power_limit"`
			Instant string `xml:"instant_power_draw"`
		} `xml:"power_readings"`
		NewPower struct {
			Draw    string `xml:"power_draw"`
			Limit   string `xml:"current_power_limit"`
			Instant string `xml:"instant_power_draw"`
		} `xml:"gpu_power_readings"`
		Processes []struct {
			PID    int    `xml:"pid"`
			Name   string `xml:"process_name"`
			Type   string `xml:"type"`
			Memory string `xml:"used_memory"`
		} `xml:"processes>process_info"`
	} `xml:"gpu"`
}

func metric(value string) *float64 {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return nil
	}
	number, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return nil
	}
	if len(fields) > 1 {
		switch fields[1] {
		case "KiB":
			number *= 1024
		case "MiB":
			number *= 1048576
		case "GiB":
			number *= 1073741824
		}
	}
	return &number
}
func first(values ...string) *float64 {
	for _, value := range values {
		if value := metric(value); value != nil {
			return value
		}
	}
	return nil
}
func ParseGPU(data []byte) ([]GPU, error) {
	if len(data) > 4*1024*1024 {
		return nil, fmt.Errorf("NVIDIA sample exceeds 4 MiB")
	}
	var source nvidiaLog
	if err := xml.Unmarshal(data, &source); err != nil {
		return nil, err
	}
	gpus := make([]GPU, 0, len(source.GPUs))
	for index, device := range source.GPUs {
		if device.UUID == "" {
			continue
		}
		gpu := GPU{
			UUID: device.UUID, Index: index, Name: device.Name, Utilization: metric(device.Utilization),
			MemoryUsed: metric(device.Used), MemoryTotal: metric(device.Total), Temperature: metric(device.Temperature),
			Power:      first(device.NewPower.Instant, device.NewPower.Draw, device.Power.Instant, device.Power.Draw),
			PowerLimit: first(device.NewPower.Limit, device.Power.Limit), Fan: metric(device.Fan), Processes: []GPUProcess{},
		}
		if number, err := strconv.Atoi(device.Minor); err == nil && number >= 0 {
			gpu.Index = number
		}
		for _, process := range device.Processes {
			gpu.Processes = append(gpu.Processes, GPUProcess{PID: process.PID, Name: process.Name, Type: process.Type, Memory: metric(process.Memory), GPU: device.UUID})
		}
		gpus = append(gpus, gpu)
	}
	return gpus, nil
}

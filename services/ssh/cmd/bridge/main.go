package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"rhine.local/sshservices/internal/native"
	"rhine.local/sshservices/internal/service"
)

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type response struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
type answer struct {
	ID       string `json:"id"`
	Value    string `json:"value"`
	Canceled bool   `json:"canceled"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--inspect-key" {
		native.InspectKey()
		return
	}
	if os.Getenv("RHINE_ASKPASS") == "1" {
		os.Exit(native.Askpass())
	}
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("rhine-bridge 1.0.0 protocol=1")
		return
	}
	encoder := json.NewEncoder(os.Stdout)
	var output sync.Mutex
	emit := func(value any) { output.Lock(); defer output.Unlock(); _ = encoder.Encode(value) }
	var current *service.Service
	var pending sync.Map
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var work sync.WaitGroup
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 8*1024*1024)
	for scanner.Scan() {
		var message request
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			emit(response{Error: "invalid request"})
			continue
		}
		if message.Method == "configure" {
			if current != nil {
				emit(response{ID: message.ID, Error: "session already configured"})
				continue
			}
			var config service.Config
			if err := json.Unmarshal(message.Params, &config); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			instance, err := service.New(config, func(event service.Event) { emit(event) }, func(challenge native.Challenge) (string, bool) {
				id := native.RandomID()
				channel := make(chan answer, 1)
				pending.Store(id, channel)
				defer pending.Delete(id)
				emit(service.Event{Event: "auth", SessionID: config.SessionID, Data: map[string]any{"id": id, "connection": challenge.Connection, "source": challenge.Source, "prompt": challenge.Prompt, "kind": challenge.Kind, "fingerprint": challenge.Fingerprint, "diagnostics": challenge.Diagnostics, "method": challenge.Method, "peer": challenge.Peer}})
				defer emit(service.Event{Event: "authClosed", SessionID: config.SessionID, Data: map[string]string{"id": id}})
				select {
				case reply := <-channel:
					return reply.Value, !reply.Canceled
				case <-ctx.Done():
					return "", false
				case <-challenge.Context.Done():
					return "", false
				case <-time.After(3 * time.Minute):
					return "", false
				}
			})
			if err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			current = instance
			emit(response{ID: message.ID, OK: true})
			current.StartFiles()
			continue
		}
		if message.Method == "answer" {
			var reply answer
			if err := json.Unmarshal(message.Params, &reply); err != nil {
				emit(response{ID: message.ID, Error: err.Error()})
				continue
			}
			channel, ok := pending.Load(reply.ID)
			if ok {
				select {
				case channel.(chan answer) <- reply:
				default:
					ok = false
				}
			}
			emit(response{ID: message.ID, OK: ok})
			continue
		}
		if message.Method == "stop" {
			break
		}
		if current == nil {
			emit(response{ID: message.ID, Error: "session not configured"})
			continue
		}
		work.Add(1)
		go func(message request, instance *service.Service) {
			defer work.Done()
			callCtx, callCancel := context.WithTimeout(ctx, 60*time.Second)
			defer callCancel()
			result, err := instance.Call(callCtx, message.Method, message.Params)
			reply := response{ID: message.ID, OK: err == nil, Result: result}
			if err != nil {
				reply.Error = err.Error()
			}
			emit(reply)
		}(message, current)
	}
	cancel()
	if current != nil {
		current.Close()
	}
	work.Wait()
}

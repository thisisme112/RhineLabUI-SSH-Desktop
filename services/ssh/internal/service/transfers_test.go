package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"rhine.local/sshservices/internal/native"
)

func testFiles(t *testing.T) (*Service, *sftp.Client) {
	t.Helper()
	a, b := net.Pipe()
	server := sftp.NewRequestServer(a, sftp.InMemHandler())
	go func() { _ = server.Serve() }()
	client, err := sftp.NewClientPipe(b, b)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{SessionID: "test", SSH: native.Config{Args: []string{"unused"}}}, func(Event) {}, func(native.Challenge) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	s.client = client
	t.Cleanup(func() { s.Close(); _ = server.Close(); _ = a.Close(); _ = b.Close() })
	return s, client
}
func writeRemote(t *testing.T, client *sftp.Client, name, data string) {
	t.Helper()
	file, err := client.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(file, data); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}
func readRemote(t *testing.T, client *sftp.Client, name string) string {
	t.Helper()
	file, err := client.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
func waitJob(t *testing.T, s *Service, id string, state string) JobSnapshot {
	t.Helper()
	end := time.Now().Add(10 * time.Second)
	for time.Now().Before(end) {
		s.mu.Lock()
		job := s.jobs[id]
		s.mu.Unlock()
		value := job.snapshot()
		if value.State == state {
			return value
		}
		if value.State == "failed" || value.State == "uncertain" {
			t.Fatalf("job failed: %+v", value)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job did not reach %s", state)
	return JobSnapshot{}
}
func queueOne(t *testing.T, s *Service, spec JobSpec) string {
	t.Helper()
	result, err := s.Queue(spec)
	if err != nil {
		t.Fatal(err)
	}
	return result.([]JobSnapshot)[0].ID
}

func TestDirectoryRoundTripAndConflictTokens(t *testing.T) {
	s, client := testFiles(t)
	if err := client.Mkdir("/data"); err != nil {
		t.Fatal(err)
	}
	input, output := t.TempDir(), t.TempDir()
	base := filepath.Join(input, "模型资料")
	if err := os.MkdirAll(filepath.Join(base, "子目录"), 0755); err != nil {
		t.Fatal(err)
	}
	content := strings.Repeat("\x00\xff中文\r\n", 4096)
	if err := os.WriteFile(filepath.Join(base, "子目录", "binary.bin"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, ".hidden"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	up := queueOne(t, s, JobSpec{Direction: "upload", Paths: []string{base}, Destination: "/data"})
	if job := waitJob(t, s, up, "completed"); job.FilesDone != 2 || job.BytesDone != int64(len(content)) {
		t.Fatalf("upload totals: %+v", job)
	}
	if readRemote(t, client, "/data/模型资料/子目录/binary.bin") != content {
		t.Fatal("binary upload changed bytes")
	}
	down := queueOne(t, s, JobSpec{Direction: "download", Paths: []string{"/data/模型资料"}, Destination: output})
	waitJob(t, s, down, "completed")
	data, err := os.ReadFile(filepath.Join(output, "模型资料", "子目录", "binary.bin"))
	if err != nil || string(data) != content {
		t.Fatalf("binary download: %v", err)
	}
	duplicate := queueOne(t, s, JobSpec{Direction: "upload", Paths: []string{base}, Destination: "/data"})
	conflict := waitJob(t, s, duplicate, "conflict").Conflict
	if _, err := s.ControlJob("conflict", duplicate, "overwrite", false, "stale-token"); err == nil {
		t.Fatal("stale conflict accepted")
	}
	if _, err := s.ControlJob("conflict", duplicate, "keep-both", false, conflict.ID); err != nil {
		t.Fatal(err)
	}
	waitJob(t, s, duplicate, "completed")
	if readRemote(t, client, "/data/模型资料 (2)/子目录/binary.bin") != content {
		t.Fatal("renamed directory descendants lost")
	}
}

func TestPaginationAndSymlinkRemoval(t *testing.T) {
	s, client := testFiles(t)
	if err := client.Mkdir("/many"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 505; i++ {
		writeRemote(t, client, "/many/"+time.Unix(int64(i), 0).Format("150405"), "x")
	}
	result, err := s.List(context.Background(), "/many", "")
	if err != nil {
		t.Fatal(err)
	}
	page := result.(map[string]any)
	if len(page["entries"].([]Entry)) != 500 || page["total"].(int) != 505 {
		t.Fatal("first page is not bounded")
	}
	next, err := s.List(context.Background(), "/many", page["cursor"].(string))
	if err != nil || len(next.(map[string]any)["entries"].([]Entry)) != 5 {
		t.Fatalf("second page: %v", err)
	}
	if _, err := s.List(context.Background(), "/", page["cursor"].(string)); err == nil {
		t.Fatal("cursor accepted for another directory")
	}
	if err := client.Symlink("/many", "/link"); err != nil {
		t.Fatal(err)
	}
	if err := s.Mutate(context.Background(), "remove", "/link", "", true); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Stat("/many"); err != nil {
		t.Fatal("recursive deletion followed a symlink")
	}
	if err := s.Mutate(context.Background(), "remove", "/", "", true); err == nil {
		t.Fatal("root removal accepted")
	}
}

func TestCommitRechecksApprovedTargetAndRollsBack(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.ToSlash(filepath.Join(dir, "target"))
	temporary := filepath.ToSlash(filepath.Join(dir, "pending"))
	write := func(file, value string) {
		t.Helper()
		if err := os.WriteFile(file, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(destination, "original")
	expected, _ := os.Stat(destination)
	write(temporary, "new")
	write(destination, "another writer has changed this file")
	record := &recovery{}
	err := commitFile(temporary, destination, expected, os.Lstat, os.Rename, os.Remove, false, nil, record)
	if err == nil || record.attempted {
		t.Fatal("changed target must be rejected before mutation")
	}
	if data, _ := os.ReadFile(destination); string(data) != "another writer has changed this file" {
		t.Fatal("changed target overwritten")
	}
	expected, _ = os.Stat(destination)
	rename := func(from, to string) error {
		if from == temporary {
			return errors.New("injected rename failure")
		}
		return os.Rename(from, to)
	}
	record = &recovery{}
	err = commitFile(temporary, destination, expected, os.Lstat, rename, os.Remove, false, nil, record)
	if err == nil || !record.attempted {
		t.Fatal("interrupted mutation must be recoverable")
	}
	if data, _ := os.ReadFile(destination); string(data) != "another writer has changed this file" {
		t.Fatal("failed commit did not restore original")
	}
	if _, err := os.Stat(temporary); err != nil {
		t.Fatal("retry source lost")
	}
}

func TestCancelConflictAndRejectInvalidLocalNames(t *testing.T) {
	s, client := testFiles(t)
	writeRemote(t, client, "/same.txt", "original")
	dir := t.TempDir()
	file := filepath.Join(dir, "same.txt")
	if err := os.WriteFile(file, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	id := queueOne(t, s, JobSpec{Direction: "upload", Paths: []string{file}, Destination: "/"})
	waitJob(t, s, id, "conflict")
	if _, err := s.ControlJob("cancel", id, "", false, ""); err != nil {
		t.Fatal(err)
	}
	waitJob(t, s, id, "canceled")
	if readRemote(t, client, "/same.txt") != "original" {
		t.Fatal("cancel modified the destination")
	}
	if safeLocalName("../escape") || safeLocalName("a\\b") || !safeLocalName("资料 01.txt") {
		t.Fatal("unsafe name validation")
	}
}

func TestRecoveryPreservesChangedTargetAndReportsCleanupFailure(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprintf("changed-%t", changed), func(t *testing.T) {
			dir := filepath.ToSlash(t.TempDir())
			record := &recovery{temporary: dir + "/pending", destination: dir + "/target", backup: dir + "/backup"}
			record.digest, _ = fileHash(strings.NewReader("committed"))
			value := "committed"
			if changed {
				value = "modified by another writer"
			}
			for name, data := range map[string]string{record.destination: value, record.temporary: "committed", record.backup: "original"} {
				if err := os.WriteFile(name, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			open := func(name string) (io.ReadCloser, error) { return os.Open(name) }
			remove := func(name string) error {
				if name == record.backup {
					return os.ErrPermission
				}
				return os.Remove(name)
			}
			if err := recoverFile(record, os.Lstat, os.Rename, remove, open); err == nil || !strings.Contains(err.Error(), record.backup) {
				t.Fatal("backup preservation/cleanup failure must be actionable", err)
			}
			if data, err := os.ReadFile(record.backup); err != nil || string(data) != "original" {
				t.Fatal("original backup lost")
			}
			if data, err := os.ReadFile(record.destination); err != nil || string(data) != value {
				t.Fatal("recovery overwrote target")
			}
			if changed {
				if err := os.Rename(record.backup, dir+"/saved-original"); err != nil {
					t.Fatal(err)
				}
			}
			if err := recoverFile(record, os.Lstat, os.Rename, os.Remove, open); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(record.temporary); !os.IsNotExist(err) {
				t.Fatal("staging file not cleaned")
			}
		})
	}
}

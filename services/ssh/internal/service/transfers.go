package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"rhine.local/sshservices/internal/native"
)

type JobSpec struct {
	Direction   string   `json:"direction"`
	Paths       []string `json:"paths"`
	Destination string   `json:"destination"`
}
type Conflict struct {
	ID           string `json:"id"`
	Path         string `json:"path"`
	Directory    bool   `json:"directory"`
	SourceSize   int64  `json:"sourceSize"`
	ExistingSize int64  `json:"existingSize"`
}
type JobSnapshot struct {
	ID            string    `json:"id"`
	Direction     string    `json:"direction"`
	Name          string    `json:"name"`
	Source        string    `json:"source"`
	Destination   string    `json:"destination"`
	State         string    `json:"state"`
	BytesDone     int64     `json:"bytesDone"`
	BytesTotal    int64     `json:"bytesTotal"`
	FilesDone     int       `json:"filesDone"`
	FilesTotal    int       `json:"filesTotal"`
	Skipped       int       `json:"skipped"`
	Rate          float64   `json:"rate"`
	Error         string    `json:"error,omitempty"`
	Conflict      *Conflict `json:"conflict,omitempty"`
	RecoveryPaths []string  `json:"recoveryPaths,omitempty"`
	Retried       bool      `json:"retried,omitempty"`
}
type decision struct {
	choice string
	all    bool
}
type recovery struct {
	temporary, destination, backup, digest string
	attempted                              bool
}
type Job struct {
	mu sync.Mutex
	JobSnapshot
	spec      JobSpec
	service   *Service
	ctx       context.Context
	cancel    context.CancelFunc
	answer    chan decision
	policy    string
	started   time.Time
	lastEvent time.Time
	recovery  *recovery
	retrying  bool
}

func (j *Job) snapshot() JobSnapshot { j.mu.Lock(); defer j.mu.Unlock(); return j.JobSnapshot }
func (j *Job) publish()              { j.service.event("transfer", j.snapshot()) }
func (j *Job) state(state string)    { j.mu.Lock(); j.State = state; j.mu.Unlock(); j.publish() }
func (j *Job) progress(n int64) {
	j.mu.Lock()
	j.BytesDone += n
	seconds := time.Since(j.started).Seconds()
	if seconds > 0 {
		j.Rate = float64(j.BytesDone) / seconds
	}
	emit := time.Since(j.lastEvent) >= 200*time.Millisecond
	if emit {
		j.lastEvent = time.Now()
	}
	j.mu.Unlock()
	if emit {
		j.publish()
	}
}
func (s *Service) Queue(spec JobSpec) (any, error) {
	if spec.Direction != "upload" && spec.Direction != "download" {
		return nil, errors.New("无效传输方向")
	}
	if len(spec.Paths) == 0 || len(spec.Paths) > 256 || !ValidPath(spec.Destination) {
		return nil, errors.New("无效传输目标或数量")
	}
	if _, err := s.files(); err != nil {
		return nil, err
	}
	for _, source := range spec.Paths {
		if !ValidPath(source) {
			return nil, errors.New("无效源路径")
		}
		if spec.Direction == "upload" && !filepath.IsAbs(source) {
			return nil, errors.New("本地路径必须是绝对路径")
		}
	}
	if spec.Direction == "download" && !filepath.IsAbs(spec.Destination) {
		return nil, errors.New("下载目录必须是绝对路径")
	}
	result := []JobSnapshot{}
	created := []*Job{}
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		return nil, errors.New("会话已结束")
	}
	if len(s.jobs)+len(spec.Paths) > 1000 {
		s.mu.Unlock()
		return nil, errors.New("本次会话的传输队列已满")
	}
	for _, source := range spec.Paths {
		ctx, cancel := context.WithCancel(s.ctx)
		name := path.Base(source)
		if spec.Direction == "upload" {
			name = filepath.Base(source)
		}
		job := &Job{
			JobSnapshot: JobSnapshot{ID: native.RandomID(), Direction: spec.Direction, Name: name, Source: source, Destination: spec.Destination, State: "queued"},
			spec:        JobSpec{Direction: spec.Direction, Paths: []string{source}, Destination: spec.Destination},
			service:     s, ctx: ctx, cancel: cancel, answer: make(chan decision, 1),
		}
		s.jobs[job.ID] = job
		result = append(result, job.snapshot())
		created = append(created, job)
		s.wg.Add(1)
	}
	s.mu.Unlock()
	for _, job := range result {
		s.event("transfer", job)
	}
	for _, job := range created {
		go job.run()
	}
	return result, nil
}
func (j *Job) run() {
	defer j.service.wg.Done()
	defer j.cancel()
	select {
	case j.service.slots <- struct{}{}:
		defer func() { <-j.service.slots }()
	case <-j.ctx.Done():
		j.state("canceled")
		return
	}
	j.started = time.Now()
	j.state("scanning")
	err := j.perform()
	j.mu.Lock()
	j.Conflict = nil
	switch {
	case err == nil:
		j.State = "completed"
	case j.recovery != nil:
		j.State = "uncertain"
		j.Error = "文件提交结果需要核查：" + err.Error()
	case j.ctx.Err() != nil:
		j.State = "canceled"
		j.Error = "传输已取消"
	default:
		j.State = "failed"
		j.Error = err.Error()
	}
	j.Rate = 0
	j.mu.Unlock()
	j.publish()
}
func (s *Service) ControlJob(method, id, choice string, all bool, conflictID string) (any, error) {
	s.mu.Lock()
	job := s.jobs[id]
	s.mu.Unlock()
	if job == nil {
		return nil, errors.New("传输任务不存在")
	}
	switch method {
	case "cancel":
		job.mu.Lock()
		if job.State == "committing" {
			job.mu.Unlock()
			return nil, errors.New("正在提交文件，请稍候")
		}
		job.mu.Unlock()
		job.cancel()
		return nil, nil
	case "conflict":
		if choice != "skip" && choice != "overwrite" && choice != "keep-both" {
			return nil, errors.New("无效冲突处理")
		}
		job.mu.Lock()
		waiting := job.State == "conflict" && job.Conflict != nil && job.Conflict.ID == conflictID
		answers := job.answer
		job.mu.Unlock()
		if !waiting {
			return nil, errors.New("该冲突已结束")
		}
		select {
		case answers <- decision{choice, all}:
			return nil, nil
		default:
			return nil, errors.New("该冲突已经回答")
		}
	case "retry":
		job.mu.Lock()
		state := job.State
		if job.retrying {
			job.mu.Unlock()
			return nil, errors.New("该任务已经重新加入队列，请查看新的任务")
		}
		job.retrying = true
		job.mu.Unlock()
		requeued := false
		defer func() {
			if !requeued {
				job.mu.Lock()
				job.retrying = false
				job.mu.Unlock()
			}
		}()
		if state != "failed" && state != "canceled" && state != "uncertain" {
			return nil, errors.New("任务尚未结束")
		}
		if state == "uncertain" {
			if err := job.recoverCommit(); err != nil {
				return nil, err
			}
		}
		result, err := s.Queue(job.spec)
		requeued = err == nil
		if requeued {
			job.mu.Lock()
			job.Retried = true
			job.mu.Unlock()
			job.publish()
		}
		return result, err
	}
	return nil, errors.New("未知队列操作")
}
func (j *Job) conflict(destination string, isDirectory bool, sourceSize, existingSize int64) (string, error) {
	if err := j.ctx.Err(); err != nil {
		return "", err
	}
	if j.policy != "" {
		return j.policy, nil
	}
	// A fresh channel prevents an old double-click answering the next file.
	j.mu.Lock()
	j.answer = make(chan decision, 1)
	answers := j.answer
	j.Conflict = &Conflict{ID: native.RandomID(), Path: destination, Directory: isDirectory, SourceSize: sourceSize, ExistingSize: existingSize}
	j.State = "conflict"
	j.mu.Unlock()
	j.publish()
	select {
	case <-j.ctx.Done():
		return "", j.ctx.Err()
	case answer := <-answers:
		if answer.all {
			j.policy = answer.choice
		}
		j.mu.Lock()
		j.Conflict = nil
		j.mu.Unlock()
		j.state("transferring")
		return answer.choice, nil
	}
}

type transferItem struct {
	relative string
	info     os.FileInfo
}

func safeLocalName(name string) bool {
	if !validName(name) || strings.Contains(name, "\\") {
		return false
	}
	if runtime.GOOS != "windows" {
		return true
	}
	if strings.ContainsAny(name, ":*?\"<>|") || strings.TrimRight(name, " .") != name {
		return false
	}
	for _, r := range name {
		if r < 32 {
			return false
		}
	}
	base := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CLOCK$" {
		return false
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9' {
		return false
	}
	return true
}
func (j *Job) scan(client *sftp.Client, local *os.Root, base string) ([]transferItem, error) {
	items := []transferItem{}
	add := func(relative string, info os.FileInfo) error {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || (!info.Mode().IsRegular() && !info.IsDir()) {
			j.mu.Lock()
			j.Skipped++
			j.mu.Unlock()
			return nil
		}
		if len(items) >= 100000 {
			return errors.New("单个目录超过 100000 项，请分批传输")
		}
		items = append(items, transferItem{relative, info})
		if !info.IsDir() {
			j.mu.Lock()
			j.FilesTotal++
			j.BytesTotal += info.Size()
			j.mu.Unlock()
		}
		return nil
	}
	if j.Direction == "upload" {
		err := fs.WalkDir(local.FS(), base, func(full string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			relative := strings.TrimPrefix(strings.TrimPrefix(full, base), "/")
			return add(relative, info)
		})
		return items, err
	}
	var walk func(string, string) error
	walk = func(full, relative string) error {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		info, err := client.Lstat(full)
		if err != nil {
			return err
		}
		if err = add(relative, info); err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		children, err := client.ReadDirContext(j.ctx, full)
		if err != nil {
			return err
		}
		for _, child := range children {
			if !validName(child.Name()) {
				return errors.New("服务器返回了无效文件名")
			}
			if !safeLocalName(child.Name()) {
				return fmt.Errorf("本地文件系统不支持名称：%s", child.Name())
			}
			if err := walk(path.Join(full, child.Name()), path.Join(relative, child.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	return items, walk(base, "")
}
func alternateName(original string, index int, isDir bool) string {
	extension := ""
	if !isDir {
		extension = path.Ext(original)
	}
	return strings.TrimSuffix(original, extension) + fmt.Sprintf(" (%d)", index) + extension
}
func choosePath(j *Job, full string, item transferItem, stat func(string) (os.FileInfo, error), root bool) (string, os.FileInfo, bool, error) {
	info, err := stat(full)
	if os.IsNotExist(err) {
		return full, nil, false, nil
	}
	if err != nil {
		return "", nil, false, err
	}
	if item.info.IsDir() && info.IsDir() && !root {
		return full, nil, false, nil
	}
	choice, err := j.conflict(full, item.info.IsDir(), item.info.Size(), info.Size())
	if err != nil {
		return "", nil, false, err
	}
	if choice == "skip" {
		return full, nil, true, nil
	}
	if choice == "keep-both" {
		for i := 2; i < 10000; i++ {
			candidate := alternateName(full, i, item.info.IsDir())
			if _, err := stat(candidate); os.IsNotExist(err) {
				return candidate, nil, false, nil
			} else if err != nil {
				return "", nil, false, err
			}
		}
		return "", nil, false, errors.New("无法生成可用的新名称")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", nil, false, errors.New("目标为符号链接，请选择保留两份")
	}
	if item.info.IsDir() != info.IsDir() {
		return "", nil, false, errors.New("目标类型不同，请选择保留两份")
	}
	if item.info.IsDir() {
		return full, nil, false, nil
	}
	return full, info, false, nil
}

func (j *Job) perform() error {
	client, err := j.service.files()
	if err != nil {
		return err
	}
	var local *os.Root
	var base string
	if j.Direction == "upload" {
		absolute, err := filepath.Abs(j.Source)
		if err != nil {
			return err
		}
		base = filepath.Base(absolute)
		local, err = os.OpenRoot(filepath.Dir(absolute))
		if err != nil {
			return err
		}
	} else {
		base = j.Source
		if !safeLocalName(path.Base(base)) {
			return errors.New("本地文件系统不支持这个名称")
		}
		local, err = os.OpenRoot(j.Destination)
		if err != nil {
			return err
		}
	}
	defer local.Close()
	items, err := j.scan(client, local, base)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return nil
	}
	j.state("transferring")
	destination := path.Join(j.Destination, filepath.Base(base))
	stat := client.Lstat
	if j.Direction == "download" {
		destination = path.Base(base)
		stat = local.Lstat
	}
	destination, replace, skip, err := choosePath(j, destination, items[0], stat, true)
	if err != nil {
		return err
	}
	if skip {
		j.mu.Lock()
		j.Skipped += j.FilesTotal
		j.mu.Unlock()
		return nil
	}
	skipped := []string{}
	renamed := map[string]string{}
	for index, item := range items {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		full := path.Join(destination, item.relative)
		omit := false
		for _, prefix := range skipped {
			if item.relative == prefix || strings.HasPrefix(item.relative, prefix+"/") {
				omit = true
				break
			}
		}
		if omit {
			if !item.info.IsDir() {
				j.mu.Lock()
				j.Skipped++
				j.mu.Unlock()
			}
			continue
		}
		longest := ""
		for prefix := range renamed {
			if (item.relative == prefix || strings.HasPrefix(item.relative, prefix+"/")) && len(prefix) > len(longest) {
				longest = prefix
			}
		}
		if longest != "" {
			full = renamed[longest] + strings.TrimPrefix(item.relative, longest)
		}
		var replacing os.FileInfo
		if index == 0 {
			replacing = replace
		}
		if index > 0 {
			original := full
			full, replacing, skip, err = choosePath(j, full, item, stat, false)
			if err != nil {
				return err
			}
			if skip {
				if item.info.IsDir() {
					skipped = append(skipped, item.relative)
				} else {
					j.mu.Lock()
					j.Skipped++
					j.mu.Unlock()
				}
				continue
			}
			if item.info.IsDir() && full != original {
				renamed[item.relative] = full
			}
		}
		if item.info.IsDir() {
			if j.Direction == "upload" {
				err = client.Mkdir(full)
			} else {
				err = local.Mkdir(full, 0755)
			}
			if err != nil && !os.IsExist(err) {
				if info, e := stat(full); e != nil || !info.IsDir() {
					return err
				}
			}
			continue
		}
		if j.Direction == "upload" {
			err = j.uploadFile(client, local, path.Join(base, item.relative), full, item, replacing)
		} else {
			err = j.downloadFile(client, local, path.Join(base, item.relative), full, item, replacing)
		}
		if err != nil {
			return err
		}
		j.mu.Lock()
		j.FilesDone++
		j.mu.Unlock()
		j.publish()
	}
	return nil
}

type progressWriter struct {
	writer io.Writer
	job    *Job
	digest io.Writer
}

func (w *progressWriter) Write(p []byte) (int, error) {
	if err := w.job.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := w.writer.Write(p)
	if n > 0 {
		w.job.progress(int64(n))
		_, _ = w.digest.Write(p[:n])
	}
	return n, err
}
func sameSource(before, after os.FileInfo) bool {
	return before.Size() == after.Size() && before.ModTime().Equal(after.ModTime())
}
func (j *Job) uploadFile(client *sftp.Client, local *os.Root, source, destination string, item transferItem, replace os.FileInfo) error {
	reader, err := local.Open(source)
	if err != nil {
		return err
	}
	defer reader.Close()
	current, err := reader.Stat()
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !sameSource(item.info, current) {
		return errors.New("源文件已变化，请重新传输")
	}
	temporary := path.Join(path.Dir(destination), ".rhine-"+j.ID+"-"+native.RandomID()+".part")
	writer, err := client.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY)
	if err != nil {
		return err
	}
	preserve := false
	defer func() {
		writer.Close()
		if !preserve {
			_ = client.Remove(temporary)
		}
	}()
	digest := sha256.New()
	_, err = io.CopyBuffer(&progressWriter{writer: writer, job: j, digest: digest}, &contextReader{ctx: j.ctx, reader: reader}, make([]byte, 65536))
	if closeErr := writer.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	current, err = reader.Stat()
	if err != nil {
		return err
	}
	if !sameSource(item.info, current) {
		return errors.New("传输期间源文件发生变化")
	}
	if err := j.ctx.Err(); err != nil {
		return err
	}
	_ = client.Chtimes(temporary, item.info.ModTime(), item.info.ModTime())
	_, atomicRename := client.HasExtension("posix-rename@openssh.com")
	record := &recovery{temporary: temporary, destination: destination, digest: hex.EncodeToString(digest.Sum(nil))}
	j.prepareCommit(record, replace != nil && !atomicRename)
	j.service.commitMu.Lock()
	err = commitFile(temporary, destination, replace, client.Lstat, client.Rename, client.Remove,
		atomicRename, client.PosixRename, record)
	j.service.commitMu.Unlock()
	if err != nil {
		preserve = record.attempted
		if !preserve {
			j.mu.Lock()
			j.recovery = nil
			j.RecoveryPaths = nil
			j.mu.Unlock()
		}
		return err
	}
	j.mu.Lock()
	j.recovery = nil
	j.RecoveryPaths = nil
	j.mu.Unlock()
	j.state("transferring")
	return nil
}
func (j *Job) downloadFile(client *sftp.Client, local *os.Root, source, destination string, item transferItem, replace os.FileInfo) error {
	reader, err := client.Open(source)
	if err != nil {
		return err
	}
	defer reader.Close()
	current, err := reader.Stat()
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !sameSource(item.info, current) {
		return errors.New("远端源文件已变化，请重新传输")
	}
	temporary := path.Join(path.Dir(destination), ".rhine-"+j.ID+"-"+native.RandomID()+".part")
	writer, err := local.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	preserve := false
	defer func() {
		writer.Close()
		if !preserve {
			_ = local.Remove(temporary)
		}
	}()
	digest := sha256.New()
	_, err = io.CopyBuffer(&progressWriter{writer: writer, job: j, digest: digest}, &contextReader{ctx: j.ctx, reader: reader}, make([]byte, 65536))
	if err == nil {
		err = writer.Sync()
	}
	if closeErr := writer.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	current, err = reader.Stat()
	if err != nil {
		return err
	}
	if !sameSource(item.info, current) {
		return errors.New("传输期间远端源文件发生变化")
	}
	if err := j.ctx.Err(); err != nil {
		return err
	}
	_ = local.Chtimes(temporary, item.info.ModTime(), item.info.ModTime())
	record := &recovery{temporary: temporary, destination: destination, digest: hex.EncodeToString(digest.Sum(nil))}
	j.prepareCommit(record, replace != nil)
	j.service.commitMu.Lock()
	err = commitFile(temporary, destination, replace, local.Lstat, local.Rename, local.Remove, false, nil, record)
	j.service.commitMu.Unlock()
	if err != nil {
		preserve = record.attempted
		if !preserve {
			j.mu.Lock()
			j.recovery = nil
			j.RecoveryPaths = nil
			j.mu.Unlock()
		}
		return err
	}
	j.mu.Lock()
	j.recovery = nil
	j.RecoveryPaths = nil
	j.mu.Unlock()
	j.state("transferring")
	return nil
}

func (j *Job) prepareCommit(record *recovery, backup bool) {
	if backup {
		record.backup = path.Join(path.Dir(record.destination), ".rhine-"+native.RandomID()+".bak")
	}
	j.mu.Lock()
	j.recovery = record
	j.RecoveryPaths = []string{record.temporary}
	if record.backup != "" {
		j.RecoveryPaths = append(j.RecoveryPaths, record.backup)
	}
	j.State = "committing"
	j.mu.Unlock()
	// Publish planned recovery locations before the first rename so the owning
	// Electron process can still show them after an unexpected worker exit.
	j.publish()
}

func commitFile(temporary, destination string, expected os.FileInfo, stat func(string) (os.FileInfo, error), rename func(string, string) error, remove func(string) error, atomic bool, atomicRename func(string, string) error, record *recovery) error {
	info, err := stat(destination)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if os.IsNotExist(err) {
		record.backup = ""
	}
	if err == nil {
		if expected == nil {
			return errors.New("目标在传输期间出现，请重新处理冲突")
		}
		if !info.Mode().IsRegular() {
			return errors.New("目标类型在传输期间变化")
		}
		if !sameSource(expected, info) || expected.Mode() != info.Mode() {
			return errors.New("目标在传输期间发生变化，请重试并重新处理冲突")
		}
		if atomic {
			record.attempted = true
			return atomicRename(temporary, destination)
		}
		if record.backup == "" {
			record.backup = path.Join(path.Dir(destination), ".rhine-"+native.RandomID()+".bak")
		}
		record.attempted = true
		if err := rename(destination, record.backup); err != nil {
			return err
		}
	}
	record.attempted = true
	if err := rename(temporary, destination); err != nil {
		if record.backup != "" {
			// Never roll a backup over a file another writer created while this
			// commit was interrupted. Recovery keeps both paths for inspection.
			if _, check := stat(destination); os.IsNotExist(check) {
				if rollback := rename(record.backup, destination); rollback != nil {
					return fmt.Errorf("提交失败：%v；原文件保留在 %s：%w", err, record.backup, rollback)
				}
			}
		}
		return err
	}
	if record.backup != "" {
		if err := remove(record.backup); err != nil {
			return fmt.Errorf("文件已提交，备份清理失败：%w", err)
		}
	}
	return nil
}
func (j *Job) recoverCommit() error {
	j.service.commitMu.Lock()
	defer j.service.commitMu.Unlock()
	j.mu.Lock()
	record := j.recovery
	j.mu.Unlock()
	if record == nil {
		return nil
	}
	client, err := j.service.files()
	if err != nil {
		return err
	}
	var stat func(string) (os.FileInfo, error)
	var rename func(string, string) error
	var remove func(string) error
	var open func(string) (io.ReadCloser, error)
	if j.Direction == "upload" {
		stat, rename, remove = client.Lstat, client.Rename, client.Remove
		open = func(name string) (io.ReadCloser, error) { return client.Open(name) }
	} else {
		root, err := os.OpenRoot(j.Destination)
		if err != nil {
			return err
		}
		defer root.Close()
		stat, rename, remove = root.Lstat, root.Rename, root.Remove
		open = func(name string) (io.ReadCloser, error) { return root.Open(name) }
	}
	if err := recoverFile(record, stat, rename, remove, open); err != nil {
		return err
	}
	j.mu.Lock()
	j.recovery = nil
	j.RecoveryPaths = nil
	j.mu.Unlock()
	return nil
}

func recoverFile(record *recovery, stat func(string) (os.FileInfo, error), rename func(string, string) error, remove func(string) error, open func(string) (io.ReadCloser, error)) error {
	removeIfExists := func(name string) error {
		if name == "" {
			return nil
		}
		if err := remove(name); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("请核查保留的恢复文件 %s：%w", name, err)
		}
		return nil
	}
	if info, err := stat(record.destination); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("提交目标已变化，请先检查目标")
		}
		file, err := open(record.destination)
		if err != nil {
			return err
		}
		digest, err := fileHash(file)
		file.Close()
		if err != nil {
			return err
		}
		if digest == record.digest {
			if err := removeIfExists(record.temporary); err != nil {
				return err
			}
			return removeIfExists(record.backup)
		}
		// A changed destination is never removed by recovery. The retried job
		// asks about this conflict again using its current directory listing.
		if record.backup != "" {
			if _, err := stat(record.backup); err == nil {
				return fmt.Errorf("目标内容已变化，原文件备份保留在 %s；请先核查并移走备份，再重试", record.backup)
			} else if !os.IsNotExist(err) {
				return err
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	} else if record.backup != "" {
		if _, err := stat(record.backup); err == nil {
			if err := rename(record.backup, record.destination); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return removeIfExists(record.temporary)
}

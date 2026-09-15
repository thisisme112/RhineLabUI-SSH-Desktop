package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/pkg/sftp"
	"rhine.local/sshservices/internal/native"
)

const maxTextBytes = 1024 * 1024

type TextDocument struct {
	Path        string `json:"path"`
	Text        string `json:"text"`
	Revision    string `json:"revision"`
	Modified    int64  `json:"modified"`
	Permissions string `json:"permissions"`
}

func readTextFile(client *sftp.Client, name string) (*TextDocument, os.FileInfo, error) {
	if !ValidPath(name) || !path.IsAbs(name) {
		return nil, nil, errors.New("请使用绝对文件路径")
	}
	before, err := client.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("仅支持普通文本文件，请打开链接的实际目标")
	}
	if before.Size() > maxTextBytes {
		return nil, nil, errors.New("文本编辑限 1 MiB；大文件请下载后编辑")
	}
	file, err := client.Open(name)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maxTextBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if len(body) > maxTextBytes || !utf8.Valid(body) || strings.ContainsRune(string(body), 0) {
		return nil, nil, errors.New("仅支持 1 MiB 以内的 UTF-8 文本文件")
	}
	after, err := client.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !sameSource(before, after) || before.Mode() != after.Mode() || !after.Mode().IsRegular() {
		return nil, nil, errors.New("文件在读取期间变化，请重新打开")
	}
	hash := sha256.New()
	_, _ = hash.Write(body)
	_, _ = fmt.Fprintf(hash, "\x00%d:%d:%s", after.Size(), after.ModTime().UnixNano(), after.Mode())
	return &TextDocument{Path: name, Text: string(body), Revision: hex.EncodeToString(hash.Sum(nil)), Modified: after.ModTime().UnixMilli(), Permissions: after.Mode().String()}, after, nil
}

func (s *Service) ReadText(ctx context.Context, name string) (any, error) {
	client, err := s.files()
	if err != nil {
		return nil, err
	}
	document, _, err := readTextFile(client, name)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return document, err
}

func (s *Service) WriteText(ctx context.Context, name, text, revision string) (any, error) {
	if len(text) > maxTextBytes || !utf8.ValidString(text) || strings.ContainsRune(text, 0) || len(revision) != 64 {
		return nil, errors.New("文本或文件版本无效")
	}
	client, err := s.files()
	if err != nil {
		return nil, err
	}
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	current, expected, err := readTextFile(client, name)
	if err != nil {
		return nil, err
	}
	if current.Revision != revision {
		return map[string]any{"saved": false, "conflict": true, "document": current}, nil
	}
	temporary := path.Join(path.Dir(name), ".rhine-edit-"+native.RandomID()+".part")
	writer, err := client.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY)
	if err != nil {
		return nil, err
	}
	preserve := false
	defer func() {
		_ = writer.Close()
		if !preserve {
			_ = client.Remove(temporary)
		}
	}()
	if err = writer.Chmod(expected.Mode().Perm()); err == nil {
		_, err = io.WriteString(writer, text)
	}
	closeErr := writer.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	// Check content again immediately before replacing; a stat alone misses
	// same-sized writes within the server's timestamp resolution.
	current, expected, err = readTextFile(client, name)
	if err != nil {
		return nil, err
	}
	if current.Revision != revision {
		return map[string]any{"saved": false, "conflict": true, "document": current}, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	_, atomicRename := client.HasExtension("posix-rename@openssh.com")
	record := &recovery{temporary: temporary, destination: name}
	err = commitFile(temporary, name, expected, client.Lstat, client.Rename, client.Remove, atomicRename, client.PosixRename, record)
	if err != nil {
		preserve = record.attempted
		return nil, fmt.Errorf("保存未能确认：%v；请重新读取远端。恢复文件：%s %s", err, temporary, record.backup)
	}
	document, _, err := readTextFile(client, name)
	if err != nil {
		return nil, fmt.Errorf("文件已提交，但重新读取失败：%w", err)
	}
	return map[string]any{"saved": true, "document": document, "conflict": document.Text != text}, nil
}

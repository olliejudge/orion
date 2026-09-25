package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// tokenLen is the length of a hex-encoded 32-byte token.
const tokenLen = 64

// newToken returns 32 random bytes, hex-encoded.
func newToken() (string, error) {
	b := make([]byte, tokenLen/2)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func validStoredToken(s string) bool {
	if len(s) != tokenLen {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// LoadToken returns the token stored at path, creating it (mode 0600, in a
// 0700 directory) if the file is missing, does not hold a valid token, or
// could be read by other users. A stable token keeps orion's URL, and the
// browser's cookie, working across restarts; deleting the file rotates it.
func LoadToken(path string) (string, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create token dir: %w", err)
	}
	// MkdirAll leaves an existing dir's mode alone; others must not be able
	// to plant a token they know.
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fmt.Errorf("secure token dir: %w", err)
	}
	if tok, err := readToken(path); err == nil && tok != "" {
		return tok, nil
	} else if err != nil {
		return "", err
	}
	tok, err := newToken()
	if err != nil {
		return "", err
	}
	// Write to a temp file and link it into place: if another orion got
	// there first, Link fails and we use its token, so concurrent first runs
	// agree. An invalid file is replaced by renaming over it.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".token-*")
	if err != nil {
		return "", fmt.Errorf("write token: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.WriteString(tok + "\n"); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("write token: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("write token: %w", err)
	}
	// A filesystem without hard links falls through to the rename.
	if err := os.Link(tmp.Name(), path); err == nil {
		return tok, nil
	} else if errors.Is(err, fs.ErrExist) {
		if got, err := readToken(path); err == nil && got != "" {
			return got, nil
		}
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", fmt.Errorf("write token: %w", err)
	}
	// Concurrent runs replacing the same invalid file: the last rename wins,
	// so use what landed rather than a token that is no longer on disk.
	if got, err := readToken(path); err == nil && got != "" {
		return got, nil
	}
	return tok, nil
}

// readToken returns the valid token stored at path, or "" if the file is
// missing, invalid, or readable by group or others (a token that may have
// leaked is replaced rather than reused).
func readToken(path string) (string, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return "", nil
	}
	b, err := io.ReadAll(io.LimitReader(f, tokenLen+2))
	if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	if tok := strings.TrimSpace(string(b)); validStoredToken(tok) {
		return tok, nil
	}
	return "", nil
}

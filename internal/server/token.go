package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
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
// 0700 directory) if the file is missing or does not hold a valid token. A
// stable token keeps orion's URL, and the browser's cookie, working across
// restarts; deleting the file rotates it.
func LoadToken(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		if tok := strings.TrimSpace(string(b)); validStoredToken(tok) {
			return tok, nil
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("read token: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create token dir: %w", err)
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
		if b, err := os.ReadFile(path); err == nil {
			if got := strings.TrimSpace(string(b)); validStoredToken(got) {
				return got, nil
			}
		}
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", fmt.Errorf("write token: %w", err)
	}
	return tok, nil
}

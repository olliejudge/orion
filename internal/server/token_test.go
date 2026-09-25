package server

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
)

var tokenRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

func TestLoadTokenCreatesPrivateFileOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orion", "token")
	a, err := LoadToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if !tokenRE.MatchString(a) {
		t.Fatalf("token %q is not 64 hex chars", a)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode = %v, want 0600", fi.Mode().Perm())
	}
	b, err := LoadToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("second load = %q, want the stored %q", b, a)
	}
}

func TestLoadTokenReplacesInvalidContents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("short\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tok, err := LoadToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if !tokenRE.MatchString(tok) {
		t.Fatalf("token %q is not 64 hex chars", tok)
	}
	if again, _ := LoadToken(path); again != tok {
		t.Fatalf("replacement was not stored: %q then %q", tok, again)
	}
}

func TestLoadTokenTrimsTrailingNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	want := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := os.WriteFile(path, []byte(want+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := LoadToken(path); err != nil || got != want {
		t.Fatalf("LoadToken = %q, %v; want %q", got, err, want)
	}
}

func TestLoadTokenConcurrentFirstRunsAgree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	const n = 8
	got := make([]string, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tok, err := LoadToken(path)
			if err != nil {
				t.Error(err)
			}
			got[i] = tok
		}()
	}
	wg.Wait()
	for _, tok := range got[1:] {
		if tok != got[0] {
			t.Fatalf("concurrent loads disagree: %q", got)
		}
	}
}

func TestLoadTokenUnwritableDirErrors(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if _, err := LoadToken(filepath.Join(dir, "sub", "token")); err == nil {
		t.Fatal("LoadToken in a read-only dir: want an error")
	}
}

func TestStartUsesGivenToken(t *testing.T) {
	want := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	h := startServer(t, Options{Token: want})
	if h.token != want {
		t.Fatalf("URL token = %q, want %q", h.token, want)
	}
}

func TestLoadTokenReplacesTokenOthersCanRead(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "orion")
	if err := os.Mkdir(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil { // beat the umask
		t.Fatal(err)
	}
	path := filepath.Join(dir, "token")
	old := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := os.WriteFile(path, []byte(old+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	tok, err := LoadToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if tok == old {
		t.Fatal("a token others could read was reused; want a fresh one")
	}
	for p, want := range map[string]os.FileMode{path: 0o600, dir: 0o700} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != want {
			t.Errorf("%s mode = %v, want %v", p, fi.Mode().Perm(), want)
		}
	}
}

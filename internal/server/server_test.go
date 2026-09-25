package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/olliejudge/orion/internal/model"
)

// fakeSource is an in-memory Source whose snapshot and subscribers tests control.
type fakeSource struct {
	mu   sync.Mutex
	snap model.Snapshot
	subs map[int]chan model.Patch
	next int
}

func newFakeSource(seq uint64) *fakeSource {
	return &fakeSource{snap: model.Snapshot{Type: "snapshot", Seq: seq, Repo: model.RepoInfo{Name: "demo"}}, subs: map[int]chan model.Patch{}}
}

func (f *fakeSource) Snapshot() model.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

func (f *fakeSource) Subscribe() (<-chan model.Patch, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.next
	f.next++
	ch := make(chan model.Patch, 16)
	f.subs[id] = ch
	return ch, func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if c, ok := f.subs[id]; ok {
			delete(f.subs, id)
			close(c)
		}
	}
}

func (f *fakeSource) setSeq(seq uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snap.Seq = seq
}

func (f *fakeSource) publish(p model.Patch) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.subs {
		c <- p
	}
}

// dropAll closes every subscriber channel, as Engine does to a slow subscriber.
func (f *fakeSource) dropAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, c := range f.subs {
		delete(f.subs, id)
		close(c)
	}
}

func (f *fakeSource) subscribers() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subs)
}

type harness struct {
	srv    *Server
	src    *fakeSource
	cancel context.CancelFunc
	base   string // http://127.0.0.1:PORT
	host   string // 127.0.0.1:PORT
	port   string
	cookie string // this server's cookie name: orion_t_PORT
	token  string
}

func startServer(t *testing.T, opt Options) *harness {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	src := newFakeSource(5)
	srv, err := Start(ctx, src, opt)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		srv: srv, src: src, cancel: cancel,
		base: "http://" + u.Host, host: u.Host, port: u.Port(),
		cookie: "orion_t_" + u.Port(), token: u.Query().Get("t"),
	}
	t.Cleanup(func() {
		cancel()
		if err := srv.Wait(); err != nil {
			t.Errorf("Wait: %v", err)
		}
	})
	return h
}

// reply is a fully read HTTP response.
type reply struct {
	StatusCode int
	Header     http.Header
	Body       string
	Cookies    []*http.Cookie
}

// get performs a GET without following redirects. cookie "" sends none;
// mutate may adjust the request (e.g. its Host) before it is sent.
func (h *harness) get(t *testing.T, path, cookie string, mutate func(*http.Request)) reply {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, h.base+path, http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: h.cookie, Value: cookie})
	}
	if mutate != nil {
		mutate(req)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return reply{StatusCode: resp.StatusCode, Header: resp.Header, Body: string(b), Cookies: resp.Cookies()}
}

var uiFS = fstest.MapFS{
	"index.html":    {Data: []byte("<h1>orion app</h1>")},
	"assets/app.js": {Data: []byte("console.log(1)")},
}

func TestStartURLHasLoopbackAndToken(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	if !regexp.MustCompile(`^http://127\.0\.0\.1:\d+/\?t=[0-9a-f]{64}$`).MatchString(h.srv.URL) {
		t.Fatalf("URL = %q", h.srv.URL)
	}
}

func TestTokenQuerySetsCookieAndRedirects(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	resp := h.get(t, "/?t="+h.token, "", nil)
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/" {
		t.Fatalf("status %d location %q, want 302 to /", resp.StatusCode, resp.Header.Get("Location"))
	}
	var c *http.Cookie
	for _, ck := range resp.Cookies {
		if ck.Name == h.cookie {
			c = ck
		}
	}
	if c == nil || c.Value != h.token || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.MaxAge != cookieMaxAge {
		t.Fatalf("cookie = %+v, want orion_t_PORT=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=%d", c, cookieMaxAge)
	}
}

func TestRejectsMissingOrWrongToken(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	for _, tc := range []struct{ path, cookie string }{
		{"/", ""},
		{"/?t=wrong", ""},
		{"/?t=" + strings.Repeat("0", 64), ""},
		{"/assets/app.js", "wrong"},
		{"/ws", ""},
	} {
		if resp := h.get(t, tc.path, tc.cookie, nil); resp.StatusCode != http.StatusForbidden {
			t.Errorf("GET %s cookie=%q: status %d, want 403", tc.path, tc.cookie, resp.StatusCode)
		}
	}
}

func TestCookieOrQueryGrantsAccess(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	if resp := h.get(t, "/", h.token, nil); resp.StatusCode != 200 || resp.Body != "<h1>orion app</h1>" {
		t.Fatalf("GET / with cookie: %d", resp.StatusCode)
	}
	if resp := h.get(t, "/assets/app.js?t="+h.token, "", nil); resp.StatusCode != 200 {
		t.Fatalf("GET asset with query token: %d", resp.StatusCode)
	}
}

func TestRejectsForeignHostHeader(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	port := h.host[strings.LastIndex(h.host, ":")+1:]
	for host, want := range map[string]int{
		"127.0.0.1:" + port:          200,
		"localhost:" + port:          200,
		"evil.example:" + port:       403,
		"127.0.0.1:1":                403,
		"localhost":                  403,
		"attacker.localhost:" + port: 403,
	} {
		resp := h.get(t, "/", h.token, func(r *http.Request) { r.Host = host })
		if resp.StatusCode != want {
			t.Errorf("Host %q: status %d, want %d", host, resp.StatusCode, want)
		}
	}
}

func TestStaticSPAFallback(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	cases := []struct {
		path   string
		status int
		body   string
	}{
		{"/assets/app.js", 200, "console.log(1)"},
		{"/some/deep/link", 200, "<h1>orion app</h1>"},
		{"/missing.js", 404, ""},
	}
	for _, c := range cases {
		resp := h.get(t, c.path, h.token, nil)
		b := resp.Body
		if resp.StatusCode != c.status || (c.body != "" && b != c.body) {
			t.Errorf("GET %s: %d %q, want %d %q", c.path, resp.StatusCode, b, c.status, c.body)
		}
	}
}

func TestServesFallbackWhenUINotBuilt(t *testing.T) {
	h := startServer(t, Options{Assets: fstest.MapFS{"fallback.html": {Data: []byte("<p>run make web</p>")}}})
	resp := h.get(t, "/anything", h.token, nil)
	if b := resp.Body; resp.StatusCode != 200 || b != "<p>run make web</p>" {
		t.Fatalf("got %d %q", resp.StatusCode, b)
	}

	h2 := startServer(t, Options{})
	resp = h2.get(t, "/", h2.token, nil)
	if b := resp.Body; resp.StatusCode != 200 || !strings.Contains(b, "make web") {
		t.Fatalf("nil Assets: got %d %q", resp.StatusCode, b)
	}
}

func TestDevModeServesNoStatic(t *testing.T) {
	h := startServer(t, Options{Dev: true, Assets: uiFS})
	if resp := h.get(t, "/", h.token, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("dev GET /: %d, want 404", resp.StatusCode)
	}
}

func TestWaitReturnsAfterCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	srv, err := Start(ctx, newFakeSource(1), Options{})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	done := make(chan error, 1)
	go func() { done <- srv.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Wait = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after ctx was cancelled")
	}
}

// TestCookiePerPortSurvivesSecondInstance: browsers scope cookies by host, not
// port, so a second orion on the fallback port must not clobber the first's.
func TestCookiePerPortSurvivesSecondInstance(t *testing.T) {
	a := startServer(t, Options{Assets: uiFS})
	b := startServer(t, Options{Assets: uiFS})
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	status := func(u string) int {
		t.Helper()
		resp, err := client.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	if got := status(a.base + "/?t=" + a.token); got != 200 {
		t.Fatalf("A login: %d", got)
	}
	if got := status(b.base + "/?t=" + b.token); got != 200 {
		t.Fatalf("B login: %d", got)
	}
	if got := status(a.base + "/"); got != 200 {
		t.Errorf("A reload after B issued its cookie: %d, want 200", got)
	}
	if got := status(b.base + "/"); got != 200 {
		t.Errorf("B reload: %d, want 200", got)
	}
	resp := a.get(t, "/", "", func(r *http.Request) {
		r.AddCookie(&http.Cookie{Name: b.cookie, Value: b.token})
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("A with only B's cookie: %d, want 403", resp.StatusCode)
	}
}

func TestRejectsHostEdgeCases(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	for _, host := range []string{
		"LOCALHOST:" + h.port,
		"localhost.:" + h.port,
		"[::1]:" + h.port,
		"127.0.0.1:5173",
		"localhost:5173",
		"127.0.0.1",
	} {
		resp := h.get(t, "/", h.token, func(r *http.Request) { r.Host = host })
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("Host %q: status %d, want 403", host, resp.StatusCode)
		}
	}
}

// TestDevModeHost: in --dev, Vite's port is allowed as Host too (the brief
// allows it for Host and Origin); foreign hosts and ports are still refused.
func TestDevModeHost(t *testing.T) {
	h := startServer(t, Options{Dev: true, Assets: uiFS})
	for host, want := range map[string]int{
		"127.0.0.1:" + h.port:    http.StatusNotFound, // allowed; dev serves no static
		"localhost:5173":         http.StatusNotFound,
		"127.0.0.1:5173":         http.StatusNotFound,
		"evil.example:5173":      http.StatusForbidden,
		"localhost:3000":         http.StatusForbidden,
		"[::1]:5173":             http.StatusForbidden,
		"evil.example:" + h.port: http.StatusForbidden,
	} {
		resp := h.get(t, "/", h.token, func(r *http.Request) { r.Host = host })
		if resp.StatusCode != want {
			t.Errorf("dev Host %q: status %d, want %d", host, resp.StatusCode, want)
		}
	}
}

// rawGet sends path byte-for-byte (no client-side cleaning) and returns the
// status line and body.
func (h *harness) rawGet(t *testing.T, path string) (string, string) {
	t.Helper()
	conn, err := net.Dial("tcp", h.host)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nCookie: %s=%s\r\nConnection: close\r\n\r\n", path, h.host, h.cookie, h.token)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.Status, string(b)
}

func TestStaticNoPathTraversal(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "ui"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ui", "index.html"), []byte("<h1>orion app</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("top secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := startServer(t, Options{Assets: os.DirFS(filepath.Join(dir, "ui"))})
	for _, p := range []string{
		"/../secret.txt",
		"/%2e%2e/secret.txt",
		"/..%2fsecret.txt",
		"/assets/../../secret.txt",
		"/../../etc/passwd",
		"/%2e%2e/%2e%2e/etc/passwd",
	} {
		status, body := h.rawGet(t, p)
		if strings.Contains(body, "top secret") || strings.Contains(body, "root:") {
			t.Errorf("GET %s escaped the asset FS: %s %q", p, status, body)
		}
		if strings.HasPrefix(status, "200") && body != "<h1>orion app</h1>" {
			t.Errorf("GET %s: 200 with unexpected body %q", p, body)
		}
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	for name, tc := range map[string]struct {
		path, cookie string
		mutate       func(*http.Request)
		status       int
	}{
		"ok":           {"/", h.token, nil, 200},
		"redirect":     {"/?t=" + h.token, "", nil, http.StatusFound},
		"no token":     {"/", "", nil, http.StatusForbidden},
		"foreign host": {"/", h.token, func(r *http.Request) { r.Host = "evil.example:" + h.port }, http.StatusForbidden},
		"not found":    {"/missing.js", h.token, nil, http.StatusNotFound},
	} {
		resp := h.get(t, tc.path, tc.cookie, tc.mutate)
		if resp.StatusCode != tc.status {
			t.Errorf("%s: status %d, want %d", name, resp.StatusCode, tc.status)
		}
		if got := resp.Header.Get("Referrer-Policy"); got != "no-referrer" {
			t.Errorf("%s: Referrer-Policy = %q, want no-referrer", name, got)
		}
		if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options = %q, want nosniff", name, got)
		}
	}
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/olliejudge/orion/internal/model"
	"github.com/olliejudge/orion/internal/server"
	"github.com/olliejudge/orion/internal/testrepo"
	"github.com/olliejudge/orion/internal/version"
)

// syncBuffer is a bytes.Buffer safe for concurrent Write and String.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestRunVersion(t *testing.T) {
	for _, arg := range []string{"--version", "-version"} {
		var stdout, stderr bytes.Buffer
		code := run([]string{arg}, &stdout, &stderr)
		if code != 0 {
			t.Fatalf("run(%q) exit code = %d, want 0 (stderr: %q)", arg, code, stderr.String())
		}
		want := "orion " + version.Version + "\n"
		if stdout.String() != want {
			t.Fatalf("run(%q) stdout = %q, want %q", arg, stdout.String(), want)
		}
	}
}

func TestRunUnknownFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--nope"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "nope") {
		t.Fatalf("stderr %q does not mention the bad flag", stderr.String())
	}
}

func TestRunHelpExitsZero(t *testing.T) {
	for _, arg := range []string{"-h", "--help"} {
		var stdout, stderr bytes.Buffer
		if code := run([]string{arg}, &stdout, &stderr); code != 0 {
			t.Fatalf("run(%q) exit code = %d, want 0", arg, code)
		}
		if !strings.Contains(stderr.String(), "usage: orion") {
			t.Fatalf("run(%q) stderr %q has no usage line", arg, stderr.String())
		}
	}
}

func TestRunTwoPathsIsUsageError(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"a", "b"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
}

func TestRunNotARepo(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--no-open", "--port", "0", t.TempDir()}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	msg := stderr.String()
	if !strings.HasPrefix(msg, "orion: ") || strings.Count(msg, "\n") != 1 {
		t.Fatalf("stderr = %q, want one line starting with \"orion: \"", msg)
	}
}

var urlRe = regexp.MustCompile(`http://127\.0\.0\.1:\d+/\?t=[0-9a-f]{64}`)

// testRepo is a synthetic repo with one commit and a nested linked worktree.
func testRepo(t *testing.T) (*testrepo.Repo, *testrepo.Repo) {
	t.Helper()
	r := testrepo.New(t)
	r.Write("README.md", "# demo\n")
	r.Add("README.md")
	r.Commit("init")
	agent := r.WorktreeAdd(".claude/worktrees/agent-a", "agent-a")
	return r, agent
}

// running is an in-process `orion` started by startRun.
type running struct {
	out, errOut *syncBuffer
	url         string // the first http://127.0.0.1:PORT/?t=TOKEN on stdout
	exit        chan int
	cancel      context.CancelFunc // plays Ctrl-C
}

// startRun runs the CLI with args in the background, waits for its URL and
// cancels it (asserting exit code 0) when the test ends.
func startRun(t *testing.T, args ...string) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	orig := baseContext
	baseContext = func() context.Context { return ctx }
	rn := &running{out: &syncBuffer{}, errOut: &syncBuffer{}, exit: make(chan int, 1), cancel: cancel}
	go func() { rn.exit <- run(args, rn.out, rn.errOut) }()
	t.Cleanup(func() {
		cancel()
		select {
		case code := <-rn.exit:
			if code != 0 {
				t.Errorf("exit %d, stderr %q", code, rn.errOut.String())
			}
		case <-time.After(10 * time.Second):
			t.Error("run did not return after cancel")
		}
		baseContext = orig
	})
	deadline := time.Now().Add(10 * time.Second)
	for rn.url = urlRe.FindString(rn.out.String()); rn.url == ""; rn.url = urlRe.FindString(rn.out.String()) {
		if time.Now().After(deadline) {
			t.Fatalf("no URL printed; stdout %q stderr %q", rn.out.String(), rn.errOut.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	return rn
}

// TestRunEndToEnd is the spec §9 integration test: orion in-process on a
// synthetic repo with a nested linked worktree, driven over a real WebSocket.
func TestRunEndToEnd(t *testing.T) {
	r, agent := testRepo(t)
	rn := startRun(t, r.Path(), "--no-open", "--port", "0") // flags after the path work too
	u, err := url.Parse(rn.url)
	if err != nil {
		t.Fatal(err)
	}

	// No token → refused.
	resp, err := http.Get("http://" + u.Host + "/")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("GET / without token: %d, want 403", resp.StatusCode)
	}

	// The browser flow: ?t= → cookie → page.
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	resp, err = client.Get(rn.url)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || resp.Request.URL.RawQuery != "" {
		t.Fatalf("GET %s: %d at %s, want 200 at /", rn.url, resp.StatusCode, resp.Request.URL)
	}

	hdr := http.Header{"Origin": {"http://" + u.Host}}
	for _, c := range jar.Cookies(&url.URL{Scheme: "http", Host: u.Host, Path: "/"}) {
		hdr.Add("Cookie", c.Name+"="+c.Value)
	}
	dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dcancel()
	conn, _, err := websocket.Dial(dctx, "ws://"+u.Host+"/ws", &websocket.DialOptions{HTTPHeader: hdr}) //nolint:bodyclose // coder/websocket owns resp.Body ("You never need to close resp.Body yourself")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()

	var snap model.Snapshot
	readJSON(t, conn, &snap)
	if snap.Type != "snapshot" || len(snap.Worktrees) != 2 {
		t.Fatalf("first message: %+v", snap)
	}
	agentID := model.IDFor(agent.Path())

	agent.Write("plan.md", "step 1\n")
	for {
		var p model.Patch
		readJSON(t, conn, &p)
		if p.Type != "patch" {
			continue
		}
		for _, c := range p.Overlays[agentID].Upsert {
			if c.Path == "plan.md" && c.Stage == model.Uncommitted {
				return
			}
		}
	}
}

func TestRunDevPrintsViteURLAfterServerURL(t *testing.T) {
	r, _ := testRepo(t)
	rn := startRun(t, "--dev", "--no-open", "--port", "0", r.Path())
	u, err := url.Parse(rn.url)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("http://localhost:%d/?t=%s", server.VitePort, u.Query().Get("t"))
	waitUntil(t, func() bool {
		out := rn.out.String()
		i, j := strings.Index(out, rn.url), strings.Index(out, want)
		return i >= 0 && j > i // Task 14 parses the first 127.0.0.1 URL; Vite's comes later
	})
}

func TestRunExitsZeroOnSIGINT(t *testing.T) {
	r, _ := testRepo(t)
	out, errOut := &syncBuffer{}, &syncBuffer{}
	exit := make(chan int, 1)
	go func() { exit <- run([]string{"--no-open", "--port", "0", r.Path()}, out, errOut) }()
	waitUntil(t, func() bool { return urlRe.MatchString(out.String()) })
	if err := syscall.Kill(os.Getpid(), syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-exit:
		if code != 0 {
			t.Fatalf("exit %d after SIGINT, want 0 (stderr %q)", code, errOut.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not exit after SIGINT")
	}
}

// TestRunCtrlCWithOpenWebSocket pins that an open browser tab does not stall
// shutdown: Ctrl-C sends it a going-away close frame and run exits promptly.
func TestRunCtrlCWithOpenWebSocket(t *testing.T) {
	r, _ := testRepo(t)
	rn := startRun(t, "--no-open", "--port", "0", r.Path())
	u, err := url.Parse(rn.url)
	if err != nil {
		t.Fatal(err)
	}
	dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dcancel()
	hdr := http.Header{"Origin": {"http://" + u.Host}}
	conn, _, err := websocket.Dial(dctx, "ws://"+u.Host+"/ws?"+u.RawQuery, &websocket.DialOptions{HTTPHeader: hdr}) //nolint:bodyclose // coder/websocket owns resp.Body
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()
	var snap model.Snapshot
	readJSON(t, conn, &snap) // the connection is live on the server

	closed := make(chan websocket.StatusCode, 1)
	go func() { // like a browser tab: always reading
		for {
			if _, _, err := conn.Read(context.Background()); err != nil {
				closed <- websocket.CloseStatus(err)
				return
			}
		}
	}()

	rn.cancel() // Ctrl-C
	select {
	case code := <-rn.exit:
		rn.exit <- code // startRun's cleanup asserts exit code 0
	case <-time.After(3 * time.Second):
		t.Fatal("run did not exit within 3s of Ctrl-C with a WebSocket open")
	}
	select {
	case st := <-closed:
		if st != websocket.StatusGoingAway {
			t.Fatalf("close status %v, want %v", st, websocket.StatusGoingAway)
		}
	case <-time.After(time.Second):
		t.Fatal("client never saw the connection close")
	}
}

// waitUntil polls cond every 10 ms for up to 10 s.
func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 10s")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatal(err)
	}
}

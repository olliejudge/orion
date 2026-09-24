package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
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

// stop plays Ctrl-C and waits up to d for run to return, leaving the exit
// code for startRun's cleanup to check.
func (rn *running) stop(t *testing.T, d time.Duration) {
	t.Helper()
	rn.cancel()
	select {
	case code := <-rn.exit:
		rn.exit <- code
	case <-time.After(d):
		t.Fatalf("run did not exit within %v of Ctrl-C", d)
	}
}

// fakeBrowser replaces openBrowser for the test and returns a func that
// lists the URLs it was asked to open. Call it before startRun, so the
// original is restored only after run has returned.
func fakeBrowser(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var urls []string
	orig := openBrowser
	openBrowser = func(u string) error {
		mu.Lock()
		defer mu.Unlock()
		urls = append(urls, u)
		return nil
	}
	t.Cleanup(func() { openBrowser = orig })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(urls)
	}
}

func TestRunOpensBrowserWithPrintedURL(t *testing.T) {
	opened := fakeBrowser(t)
	r, _ := testRepo(t)
	rn := startRun(t, "--port", "0", r.Path())
	rn.stop(t, 10*time.Second) // openBrowser runs before run can return
	if got := opened(); len(got) != 1 || got[0] != rn.url {
		t.Fatalf("opened %q, want exactly [%q]", got, rn.url)
	}
}

func TestRunNoOpenAndDevSkipBrowser(t *testing.T) {
	for _, flag := range []string{"--no-open", "--dev"} {
		t.Run(flag, func(t *testing.T) {
			opened := fakeBrowser(t)
			r, _ := testRepo(t)
			rn := startRun(t, flag, "--port", "0", r.Path())
			rn.stop(t, 10*time.Second)
			if got := opened(); len(got) != 0 {
				t.Fatalf("%s opened %q, want nothing", flag, got)
			}
		})
	}
}

// TestRunCtrlCDuringStartupExitsZero: Ctrl-C while the repo is still being
// opened kills git's children; that is an interrupt, not an error.
func TestRunCtrlCDuringStartupExitsZero(t *testing.T) {
	r, _ := testRepo(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	orig := baseContext
	baseContext = func() context.Context { return ctx }
	t.Cleanup(func() { baseContext = orig })
	var stdout, stderr bytes.Buffer
	if code := run([]string{"--no-open", "--port", "0", r.Path()}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d, want 0 (stderr %q)", code, stderr.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

// busyPort holds a 127.0.0.1 port for the rest of the test.
func busyPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

// TestRunDevRefusesBusyPort: Vite proxies /ws to one fixed port, so --dev
// must not quietly fall back to another.
func TestRunDevRefusesBusyPort(t *testing.T) {
	r, _ := testRepo(t)
	port := strconv.Itoa(busyPort(t))
	var stdout, stderr bytes.Buffer
	if code := run([]string{"--dev", "--port", port, r.Path()}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit %d, want 1 (stdout %q)", code, stdout.String())
	}
	msg := stderr.String()
	if !strings.HasPrefix(msg, "orion: ") || strings.Count(msg, "\n") != 1 || !strings.Contains(msg, port) {
		t.Fatalf("stderr = %q, want one \"orion: \" line naming port %s", msg, port)
	}
	if urlRe.MatchString(stdout.String()) {
		t.Fatalf("stdout %q has a URL; nothing should be served", stdout.String())
	}
}

func TestRunFallsBackFromBusyPortWithoutDev(t *testing.T) {
	r, _ := testRepo(t)
	port := strconv.Itoa(busyPort(t))
	rn := startRun(t, "--no-open", "--port", port, r.Path())
	u, err := url.Parse(rn.url)
	if err != nil {
		t.Fatal(err)
	}
	if u.Port() == port {
		t.Fatalf("served on busy port %s", port)
	}
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

	m := newMirror(t, conn)
	if len(m.worktrees) != 2 {
		t.Fatalf("snapshot has %d worktrees, want 2", len(m.worktrees))
	}
	agentID := model.IDFor(agent.Path())

	// An uncommitted file in the nested worktree.
	agent.Write("plan.md", "step 1\n")
	m.await("plan.md uncommitted in agent-a", func() bool {
		e, ok := m.overlays[agentID]["plan.md"]
		return ok && e.Kind == model.Added && e.Stage == model.Uncommitted
	})

	// Committed there: the entry turns committed and a commit row appears.
	agent.Add("plan.md")
	head := agent.Commit("add plan")
	m.await("plan.md committed in agent-a, with a commit row", func() bool {
		e, ok := m.overlays[agentID]["plan.md"]
		return ok && e.Kind == model.Added && e.Stage == model.Committed &&
			m.hasActivity(func(a model.Activity) bool {
				return a.Kind == "commit" && a.Worktree == agentID && a.Sha == head && a.Subject == "add plan"
			})
	})

	// Merged into base from the main worktree: the entry leaves agent-a's
	// overlay, base gains the file and a merge row appears.
	r.Merge("agent-a")
	m.await("plan.md merged into base, with a merge row", func() bool {
		_, inOverlay := m.overlays[agentID]["plan.md"]
		_, inBase := m.base["plan.md"]
		return !inOverlay && inBase && m.hasActivity(func(a model.Activity) bool {
			return a.Kind == "merge" && a.Worktree == agentID
		})
	})

	// A plain mv without git add arrives as a rename.
	agent.Move("plan.md", "notes/plan.md")
	m.await("notes/plan.md renamed from plan.md in agent-a", func() bool {
		e, ok := m.overlays[agentID]["notes/plan.md"]
		_, oldPath := m.overlays[agentID]["plan.md"]
		return ok && !oldPath && e.Kind == model.Renamed && e.From == "plan.md" && e.Stage == model.Uncommitted &&
			m.hasActivity(func(a model.Activity) bool {
				return a.Kind == "renamed" && a.Worktree == agentID && a.Path == "notes/plan.md" && a.From == "plan.md"
			})
	})
}

// mirror is a client-side copy of the model, kept current from the
// WebSocket the way the browser keeps its own.
type mirror struct {
	t         *testing.T
	conn      *websocket.Conn
	worktrees []model.Worktree
	base      map[string]int64
	overlays  map[model.WorktreeID]map[string]model.ChangeEntry
	activity  []model.Activity
}

// newMirror reads the snapshot that opens every connection.
func newMirror(t *testing.T, conn *websocket.Conn) *mirror {
	t.Helper()
	m := &mirror{t: t, conn: conn}
	if typ := m.read(10 * time.Second); typ != "snapshot" {
		t.Fatalf("first message is %q, want snapshot", typ)
	}
	return m
}

// await applies messages until cond holds, failing after 15 s.
func (m *mirror) await(what string, cond func() bool) {
	m.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		left := time.Until(deadline)
		if left <= 0 {
			m.t.Fatalf("timed out waiting for %s; overlays %+v", what, m.overlays)
		}
		m.read(left)
	}
}

func (m *mirror) hasActivity(match func(model.Activity) bool) bool {
	return slices.ContainsFunc(m.activity, match)
}

// read applies the next message and returns its type.
func (m *mirror) read(timeout time.Duration) string {
	m.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, data, err := m.conn.Read(ctx)
	if err != nil {
		m.t.Fatalf("read: %v; overlays %+v", err, m.overlays)
	}
	var msg struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		m.t.Fatal(err)
	}
	switch msg.Type {
	case "snapshot": // the first message, or a resync
		var s model.Snapshot
		if err := json.Unmarshal(data, &s); err != nil {
			m.t.Fatal(err)
		}
		m.worktrees, m.activity = s.Worktrees, s.Activity
		m.base = map[string]int64{}
		for _, f := range s.Tree {
			m.base[f.Path] = f.Size
		}
		m.overlays = map[model.WorktreeID]map[string]model.ChangeEntry{}
		for id, entries := range s.Overlays {
			m.overlays[id] = map[string]model.ChangeEntry{}
			for _, e := range entries {
				m.overlays[id][e.Path] = e
			}
		}
	case "patch":
		var p model.Patch
		if err := json.Unmarshal(data, &p); err != nil {
			m.t.Fatal(err)
		}
		if p.Worktrees != nil {
			m.worktrees = p.Worktrees
		}
		if p.Base != nil {
			for _, f := range p.Base.Upsert {
				m.base[f.Path] = f.Size
			}
			for _, path := range p.Base.Remove {
				delete(m.base, path)
			}
		}
		for id, op := range p.Overlays {
			if m.overlays[id] == nil {
				m.overlays[id] = map[string]model.ChangeEntry{}
			}
			for _, e := range op.Upsert {
				m.overlays[id][e.Path] = e
			}
			for _, path := range op.Remove {
				delete(m.overlays[id], path)
			}
		}
		m.activity = append(m.activity, p.Activity...)
	}
	return msg.Type
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

	rn.stop(t, 3*time.Second)
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

//go:build darwin || linux

package main

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/olliejudge/orion/internal/model"
)

// TestMainExitsZeroOnSIGINTWithBrowserTab runs orion as a real process with
// default flags (so it spawns the platform's browser opener, here a stub on
// PATH), connects a WebSocket client like the opened tab, then sends the
// process one SIGINT: it must exit 0 with nothing on stderr (spec §7).
func TestMainExitsZeroOnSIGINTWithBrowserTab(t *testing.T) {
	r, _ := testRepo(t)

	bin := t.TempDir()
	opened := filepath.Join(bin, "opened")
	opener := map[string]string{"darwin": "open", "linux": "xdg-open"}[runtime.GOOS]
	script := "#!/bin/sh\nprintf '%s\\n' \"$1\" > '" + opened + "'\n"
	if err := os.WriteFile(filepath.Join(bin, opener), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(os.Args[0], "--port", "0", r.Path())
	// A temp HOME keeps the subprocess's saved token (os.UserConfigDir) out
	// of the user's real config dir.
	home := t.TempDir()
	cmd.Env = append(os.Environ(), runMainEnv+"=1", "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, ".config"))
	out, errOut := &syncBuffer{}, &syncBuffer{}
	cmd.Stdout, cmd.Stderr = out, errOut
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var waitErr error
	exited := make(chan struct{})
	go func() { waitErr = cmd.Wait(); close(exited) }()
	t.Cleanup(func() {
		select {
		case <-exited:
		default:
			_ = cmd.Process.Kill()
			<-exited
		}
	})

	waitUntil(t, func() bool { return urlRe.MatchString(out.String()) })
	printed := urlRe.FindString(out.String())
	waitUntil(t, func() bool { b, _ := os.ReadFile(opened); return strings.TrimSpace(string(b)) == printed })

	u, err := url.Parse(printed)
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
	readJSON(t, conn, &snap)
	closed := make(chan websocket.StatusCode, 1)
	go func() { // like the browser tab: always reading
		for {
			if _, _, err := conn.Read(context.Background()); err != nil {
				closed <- websocket.CloseStatus(err)
				return
			}
		}
	}()

	if err := syscall.Kill(cmd.Process.Pid, syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
		if code := cmd.ProcessState.ExitCode(); code != 0 || errOut.String() != "" {
			t.Fatalf("exit %d (%v) after one SIGINT, stderr %q; want exit 0 and no stderr", code, waitErr, errOut.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("orion did not exit within 10s of SIGINT")
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

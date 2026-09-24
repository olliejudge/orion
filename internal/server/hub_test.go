package server

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/olliejudge/orion/internal/model"
)

type msg struct {
	Type string `json:"type"`
	Seq  uint64 `json:"seq"`
}

// dial opens /ws with the given Origin and cookie ("" = header absent). It
// returns the handshake's HTTP status (0 when there was no response).
func (h *harness) dial(t *testing.T, origin, cookie string) (*websocket.Conn, int, error) {
	t.Helper()
	hdr := http.Header{}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	if cookie != "" {
		hdr.Set("Cookie", "orion_t="+cookie)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, "ws://"+h.host+"/ws", &websocket.DialOptions{HTTPHeader: hdr}) //nolint:bodyclose // coder/websocket owns resp.Body ("You never need to close resp.Body yourself")
	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	if c != nil {
		t.Cleanup(func() { _ = c.CloseNow() })
	}
	return c, status, err
}

func (h *harness) mustDial(t *testing.T) *websocket.Conn {
	t.Helper()
	c, _, err := h.dial(t, h.base, h.token)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func read(t *testing.T, c *websocket.Conn) msg {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var m msg
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestWSRejectsForeignOrigin(t *testing.T) {
	h := startServer(t, Options{})
	for _, origin := range []string{"", "http://evil.example", "http://127.0.0.1:1", "https://" + h.host} {
		_, status, err := h.dial(t, origin, h.token)
		if err == nil || status != http.StatusForbidden {
			t.Errorf("Origin %q: err=%v status=%d, want 403", origin, err, status)
		}
	}
}

func TestWSAcceptsQueryToken(t *testing.T) {
	h := startServer(t, Options{})
	hdr := http.Header{"Origin": {"http://localhost:" + h.host[len("127.0.0.1:"):]}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws://"+h.host+"/ws?t="+h.token, &websocket.DialOptions{HTTPHeader: hdr}) //nolint:bodyclose // coder/websocket owns resp.Body ("You never need to close resp.Body yourself")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if m := read(t, c); m.Type != "snapshot" {
		t.Fatalf("first message %+v, want snapshot", m)
	}
}

func TestWSSnapshotThenPatches(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	if m := read(t, c); m.Type != "snapshot" || m.Seq != 5 {
		t.Fatalf("first message %+v, want snapshot seq 5", m)
	}
	waitSubs(t, h.src, 1)
	h.src.publish(model.Patch{Type: "patch", Seq: 5}) // already covered by the snapshot: dropped
	h.src.publish(model.Patch{Type: "patch", Seq: 6})
	if m := read(t, c); m.Type != "patch" || m.Seq != 6 {
		t.Fatalf("got %+v, want patch seq 6", m)
	}
}

func TestWSResyncSendsFreshSnapshot(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	read(t, c)
	h.src.setSeq(9)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, map[string]string{"type": "resync"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Type != "snapshot" || m.Seq != 9 {
		t.Fatalf("got %+v, want snapshot seq 9", m)
	}
}

func TestWSResubscribesWhenDropped(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	read(t, c)
	waitSubs(t, h.src, 1)
	h.src.setSeq(20)
	h.src.dropAll()
	if m := read(t, c); m.Type != "snapshot" || m.Seq != 20 {
		t.Fatalf("got %+v, want fresh snapshot seq 20 after drop", m)
	}
	waitSubs(t, h.src, 1)
	h.src.publish(model.Patch{Type: "patch", Seq: 21})
	if m := read(t, c); m.Type != "patch" || m.Seq != 21 {
		t.Fatalf("got %+v, want patch 21 on the new subscription", m)
	}
}

func TestWSUnsubscribesOnDisconnect(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	read(t, c)
	waitSubs(t, h.src, 1)
	_ = c.Close(websocket.StatusNormalClosure, "bye")
	waitSubs(t, h.src, 0)
}

func TestWSShutdownSendsGoingAway(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	read(t, c)
	h.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := c.Read(ctx)
	if got := websocket.CloseStatus(err); got != websocket.StatusGoingAway {
		t.Fatalf("close status = %v (err %v), want StatusGoingAway", got, err)
	}
}

func TestWSDevModeAllowsViteOrigin(t *testing.T) {
	h := startServer(t, Options{Dev: true})
	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:5173", h.base} {
		c, _, err := h.dial(t, origin, h.token)
		if err != nil {
			t.Fatalf("dev Origin %q: %v", origin, err)
		}
		if m := read(t, c); m.Type != "snapshot" {
			t.Fatalf("dev Origin %q: got %+v, want snapshot", origin, m)
		}
	}
	for _, origin := range []string{"http://evil.example:5173", "http://localhost:3000"} {
		if _, status, _ := h.dial(t, origin, h.token); status != http.StatusForbidden {
			t.Errorf("dev Origin %q: status %d, want 403", origin, status)
		}
	}
}

func TestWSRejectsViteOriginWithoutDev(t *testing.T) {
	h := startServer(t, Options{})
	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:5173"} {
		if _, status, _ := h.dial(t, origin, h.token); status != http.StatusForbidden {
			t.Errorf("non-dev Origin %q: status %d, want 403", origin, status)
		}
	}
}

func waitSubs(t *testing.T, f *fakeSource, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for f.subscribers() != n {
		if time.Now().After(deadline) {
			t.Fatalf("subscribers = %d, want %d", f.subscribers(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

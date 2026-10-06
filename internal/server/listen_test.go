package server

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func TestListenZeroPicksFreePort(t *testing.T) {
	ln, err := listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	addr := ln.Addr().(*net.TCPAddr)
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) || addr.Port == 0 {
		t.Fatalf("addr = %v, want 127.0.0.1:<non-zero>", addr)
	}
}

func TestListenFallsBackToNextPort(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	taken := busy.Addr().(*net.TCPAddr).Port

	ln, err := listen(taken)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	got := ln.Addr().(*net.TCPAddr).Port
	if got <= taken || got > taken+20 {
		t.Fatalf("port = %d, want in (%d, %d]", got, taken, taken+20)
	}
}

func TestListenRejectsOutOfRangePort(t *testing.T) {
	for _, port := range []int{-1, 65536} {
		ln, err := listen(port)
		if err == nil {
			_ = ln.Close()
			t.Fatalf("listen(%d) succeeded on %v, want error", port, ln.Addr())
		}
		if strings.Contains(err.Error(), "%!") {
			t.Fatalf("listen(%d) error is misformatted: %q", port, err)
		}
	}
}

// fakeEnv is an environment for inherited: a map, read and unset in place.
type fakeEnv map[string]string

func (e fakeEnv) get(k string) string  { return e[k] }
func (e fakeEnv) unset(k string) error { delete(e, k); return nil }

// passedFD returns a fresh fd for ln's socket that inherited may take over
// (and close), as systemd hands one to the process it starts.
func passedFD(t *testing.T, ln net.Listener) int {
	t.Helper()
	f, err := ln.(*net.TCPListener).File()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	fd, err := syscall.Dup(int(f.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	return fd
}

func TestInheritedTakesTheSystemdSocket(t *testing.T) {
	orig, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = orig.Close() }()
	env := fakeEnv{"LISTEN_PID": "42", "LISTEN_FDS": "1", "LISTEN_FDNAMES": "orion.socket", "HOME": "/h"}
	ln, ok, err := inherited(env.get, env.unset, 42, passedFD(t, orig))
	if err != nil || !ok {
		t.Fatalf("inherited = %v, %v, %v; want a listener", ln, ok, err)
	}
	defer func() { _ = ln.Close() }()
	if got, want := ln.Addr().(*net.TCPAddr).Port, orig.Addr().(*net.TCPAddr).Port; got != want {
		t.Fatalf("port = %d, want the socket's %d", got, want)
	}
	for _, k := range []string{"LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"} {
		if _, set := env[k]; set {
			t.Errorf("%s still set; git children would inherit it", k)
		}
	}
	if env["HOME"] != "/h" {
		t.Error("an unrelated variable was unset")
	}
	go func() {
		if c, err := net.Dial("tcp", ln.Addr().String()); err == nil {
			_ = c.Close()
		}
	}()
	c, err := ln.Accept()
	if err != nil {
		t.Fatalf("Accept on the inherited socket: %v", err)
	}
	_ = c.Close()
}

func TestInheritedIgnoresAnotherProcessesSockets(t *testing.T) {
	env := fakeEnv{"LISTEN_PID": "7", "LISTEN_FDS": "1"}
	ln, ok, err := inherited(env.get, env.unset, 42, 3)
	if ln != nil || ok || err != nil {
		t.Fatalf("inherited = %v, %v, %v; want nothing", ln, ok, err)
	}
	if len(env) != 2 {
		t.Fatal("variables meant for another process were unset")
	}
	ln, ok, err = inherited(fakeEnv{}.get, fakeEnv{}.unset, 42, 3)
	if ln != nil || ok || err != nil {
		t.Fatalf("no LISTEN_PID: inherited = %v, %v, %v; want nothing", ln, ok, err)
	}
}

func TestInheritedRejectsMoreThanOneSocket(t *testing.T) {
	env := fakeEnv{"LISTEN_PID": "42", "LISTEN_FDS": "2"}
	_, _, err := inherited(env.get, env.unset, 42, 3)
	if err == nil || !strings.Contains(err.Error(), `expected one socket from systemd (LISTEN_FDS), got "2"`) {
		t.Fatalf("err = %v, want the one-socket error", err)
	}
}

func TestInheritedRejectsANonLoopbackSocket(t *testing.T) {
	orig, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = orig.Close() }()
	env := fakeEnv{"LISTEN_PID": "42", "LISTEN_FDS": "1"}
	_, _, err = inherited(env.get, env.unset, 42, passedFD(t, orig))
	if err == nil || !strings.Contains(err.Error(), "not loopback") {
		t.Fatalf("err = %v, want the loopback error", err)
	}
}

// withSystemdSocket makes Start see ln as the socket systemd passed.
func withSystemdSocket(t *testing.T, ln net.Listener) {
	t.Helper()
	was := systemdSocket
	systemdSocket = func() (net.Listener, bool, error) { return ln, true, nil }
	t.Cleanup(func() { systemdSocket = was })
}

func TestStartServesOnTheSystemdSocket(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	withSystemdSocket(t, ln)
	h := startServer(t, Options{Port: port})
	if h.port != strconv.Itoa(port) || h.srv.port != strconv.Itoa(port) {
		t.Fatalf("port = %s (server %s), want the socket's %d", h.port, h.srv.port, port)
	}
	if resp := h.get(t, "/healthz", "", nil); resp.StatusCode != 200 {
		t.Fatalf("GET /healthz on the systemd socket: %d", resp.StatusCode)
	}
}

func TestStartRejectsAPortThatIsNotTheSystemdSockets(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	withSystemdSocket(t, ln)
	other := port + 1
	if other > MaxPort {
		other = port - 1
	}
	_, err = Start(context.Background(), newFakeSource(1), Options{Port: other})
	want := fmt.Sprintf("--port %d does not match the systemd socket's port %d", other, port)
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

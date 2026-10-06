package server

import (
	"fmt"
	"net"
	"os"
	"strconv"
)

const (
	portTries = 20    // how many ports after the requested one listen tries
	MaxPort   = 65535 // the highest TCP port
)

// listen binds 127.0.0.1:port, falling back to port+1 … port+20 when taken.
// Port 0 asks the OS for any free port (used by tests).
func listen(port int) (net.Listener, error) {
	if port < 0 || port > MaxPort {
		return nil, fmt.Errorf("port %d is out of range 1-%d", port, MaxPort)
	}
	if port == 0 {
		return net.Listen("tcp", "127.0.0.1:0")
	}
	last := min(port+portTries, MaxPort)
	var firstErr error
	for p := port; p <= last; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
		if err == nil {
			return ln, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, fmt.Errorf("no free port in %d-%d: %w", port, last, firstErr)
}

// inherited returns the listening socket systemd passed this process (socket
// activation, see sd_listen_fds(3)), if any: with LISTEN_PID naming `pid`,
// LISTEN_FDS must be "1" and the socket, at `fd` (3 under systemd), must be a
// loopback TCP listener. It returns (nil, false, nil) when systemd passed
// nothing, so orion binds a port itself as usual. Once claimed, the
// LISTEN_* variables are unset so git children never inherit them.
func inherited(getenv func(string) string, unsetenv func(string) error, pid, fd int) (net.Listener, bool, error) {
	if getenv("LISTEN_PID") != strconv.Itoa(pid) {
		return nil, false, nil
	}
	defer func() {
		for _, k := range []string{"LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"} {
			_ = unsetenv(k)
		}
	}()
	if n := getenv("LISTEN_FDS"); n != "1" {
		return nil, false, fmt.Errorf("expected one socket from systemd (LISTEN_FDS), got %q", n)
	}
	f := os.NewFile(uintptr(fd), "systemd-socket")
	ln, err := net.FileListener(f)
	_ = f.Close() // FileListener dups the fd
	if err != nil {
		return nil, false, fmt.Errorf("use the socket from systemd: %w", err)
	}
	if a, ok := ln.Addr().(*net.TCPAddr); !ok || !a.IP.IsLoopback() {
		_ = ln.Close()
		return nil, false, fmt.Errorf("the socket from systemd is %s, not loopback", ln.Addr())
	}
	return ln, true, nil
}

package server

import (
	"fmt"
	"net"
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

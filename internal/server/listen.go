package server

import (
	"fmt"
	"net"
	"strconv"
)

// portTries is how many ports after the requested one listen tries.
const portTries = 20

// listen binds 127.0.0.1:port, falling back to port+1 … port+20 when taken.
// Port 0 asks the OS for any free port (used by tests).
func listen(port int) (net.Listener, error) {
	if port == 0 {
		return net.Listen("tcp", "127.0.0.1:0")
	}
	var firstErr error
	for p := port; p <= port+portTries && p <= 65535; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
		if err == nil {
			return ln, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, fmt.Errorf("no free port in %d-%d: %w", port, port+portTries, firstErr)
}

package server

import (
	"net"
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

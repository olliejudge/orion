//go:build darwin || linux

package main

import "testing"

func TestBrowserCommandOwnProcessGroup(t *testing.T) {
	cmd, err := browserCommand("http://127.0.0.1:1/")
	if err != nil {
		t.Fatal(err)
	}
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatalf("SysProcAttr = %+v, want Setpgid", cmd.SysProcAttr)
	}
}

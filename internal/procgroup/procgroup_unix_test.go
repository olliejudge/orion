//go:build unix

package procgroup

import (
	"os/exec"
	"testing"
)

func TestIsolate(t *testing.T) {
	cmd := exec.Command("true")
	Isolate(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatalf("SysProcAttr = %+v, want Setpgid", cmd.SysProcAttr)
	}
	if cmd.WaitDelay != WaitDelay {
		t.Fatalf("WaitDelay = %v, want %v", cmd.WaitDelay, WaitDelay)
	}
	if err := cmd.Run(); err != nil { // still runs normally
		t.Fatal(err)
	}
}

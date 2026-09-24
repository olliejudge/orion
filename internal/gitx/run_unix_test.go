//go:build unix

package gitx

import (
	"testing"
	"time"
)

// git runs in its own process group, so a terminal Ctrl-C reaches only
// orion, which then cancels git through the context.
func TestRunnerCommandOwnProcessGroup(t *testing.T) {
	cmd := Runner{}.command(ctx, t.TempDir(), "version")
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatalf("SysProcAttr = %+v, want Setpgid", cmd.SysProcAttr)
	}
	if cmd.WaitDelay != 2*time.Second {
		t.Fatalf("WaitDelay = %v, want 2s", cmd.WaitDelay)
	}
}

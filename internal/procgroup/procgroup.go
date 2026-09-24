// Package procgroup keeps orion's child processes out of the terminal's
// foreground process group, so a Ctrl-C reaches only orion, which then stops
// its children itself (by cancelling their context).
package procgroup

import (
	"os/exec"
	"time"
)

// WaitDelay bounds how long Wait waits for a killed child's output pipes.
const WaitDelay = 2 * time.Second

// Isolate starts cmd in its own process group (on unix; elsewhere it only
// sets WaitDelay). Call it before cmd.Start.
func Isolate(cmd *exec.Cmd) {
	setpgid(cmd)
	cmd.WaitDelay = WaitDelay
}

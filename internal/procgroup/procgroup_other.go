//go:build !unix

package procgroup

import "os/exec"

func setpgid(*exec.Cmd) {}

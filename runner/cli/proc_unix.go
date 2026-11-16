//go:build unix

package cli

import (
	"os"
	"syscall"
)

// killGroup kills the process group the CLI leads: the CLI and every
// child it started.
func killGroup(p *os.Process) {
	if p != nil && p.Pid > 0 {
		_ = syscall.Kill(-p.Pid, syscall.SIGKILL)
	}
}

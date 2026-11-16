//go:build !unix

package cli

import (
	"os"
	"syscall"
)

// sysProcAttr has no process group outside Unix.
func sysProcAttr() *syscall.SysProcAttr { return nil }

// killGroup kills the CLI itself (its children are not reached outside
// Unix).
func killGroup(p *os.Process) {
	if p != nil {
		_ = p.Kill()
	}
}

//go:build unix && !linux

package cli

import "syscall"

// sysProcAttr runs the CLI in its own process group.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

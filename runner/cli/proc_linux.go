//go:build linux

package cli

import "syscall"

// sysProcAttr runs the CLI in its own process group, and has the kernel
// kill it should the server die first.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

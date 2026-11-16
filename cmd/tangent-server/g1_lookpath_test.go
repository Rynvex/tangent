package main

import "os/exec"

// Tests never depend on the CLIs installed on the machine that runs them:
// every executable is missing unless a test stands in its own lookPath.
func init() {
	lookPath = func(string) (string, error) { return "", exec.ErrNotFound }
}

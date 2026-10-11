//go:build !linux

// The agent is built for Linux servers only; this keeps `go build ./...` and
// `go vet ./...` working on the desktop's own platforms.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "rhine-agent runs on Linux servers")
	os.Exit(2)
}

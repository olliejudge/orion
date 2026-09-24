// Command orion serves a live, animated map of a git repository.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/olliejudge/orion/internal/version"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses args and executes the CLI, returning the process exit code.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("orion", flag.ContinueOnError)
	fs.SetOutput(stderr)
	showVersion := fs.Bool("version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		fmt.Fprintf(stdout, "orion %s\n", version.Version)
		return 0
	}
	fmt.Fprintln(stderr, "orion: the live map is not implemented yet")
	return 1
}

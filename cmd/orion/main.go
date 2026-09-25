// Command orion serves a live, animated map of a git repository.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/procgroup"
	"github.com/olliejudge/orion/internal/repo"
	"github.com/olliejudge/orion/internal/server"
	"github.com/olliejudge/orion/internal/version"
	"github.com/olliejudge/orion/internal/webassets"
)

// baseContext is the parent of run's signal context; tests replace it with a
// cancellable one to stand in for Ctrl-C.
var baseContext = context.Background

// tokenPath is where the auth token is kept, so orion's URL stays the same
// across runs. Tests point it at a temp dir.
var tokenPath = func() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "orion", "token"), nil
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses args and executes the CLI, returning the process exit code:
// 0 ok (including Ctrl-C), 1 runtime error, 2 usage error.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("orion", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: orion [path] [--port N] [--no-open] [--base BRANCH] [--dev] [--version]")
		fs.PrintDefaults()
	}
	port := fs.Int("port", 7070, "port to listen on (the next free port is used if taken)")
	noOpen := fs.Bool("no-open", false, "do not open the browser")
	base := fs.String("base", "", "branch to compare against (default: origin/HEAD, main, master, current)")
	dev := fs.Bool("dev", false, "serve only /ws; the UI comes from the Vite dev server")
	showVersion := fs.Bool("version", false, "print the version and exit")

	// Go's flag package stops at the first positional argument; keep parsing
	// so `orion . --port 8080` works as well as `orion --port 8080 .`.
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return 0
			}
			return 2
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		args = fs.Args()[1:]
	}
	if *showVersion {
		fmt.Fprintf(stdout, "orion %s\n", version.Version)
		return 0
	}
	if len(positional) > 1 {
		fs.Usage()
		return 2
	}
	if *port < 0 || *port > server.MaxPort {
		fmt.Fprintf(stderr, "orion: invalid --port %d: must be 1-%d\n", *port, server.MaxPort)
		return 2
	}
	path := "."
	if len(positional) == 1 {
		path = positional[0]
	}

	ctx, stop := signal.NotifyContext(baseContext(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	eng, err := repo.Open(ctx, path, *base, gitx.Runner{})
	if err != nil {
		if ctx.Err() != nil {
			return 0 // Ctrl-C during startup interrupted git: not a failure
		}
		fmt.Fprintln(stderr, "orion:", firstLine(err))
		return 1
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	srv, err := server.Start(ctx, eng, server.Options{
		Port: *port, Dev: *dev, Assets: webassets.FS(), Token: loadToken(stderr),
	})
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		fmt.Fprintln(stderr, "orion:", firstLine(err))
		return 1
	}
	u, err := url.Parse(srv.URL)
	if err != nil {
		fmt.Fprintln(stderr, "orion:", err)
		return 1
	}
	if *dev && *port != 0 && u.Port() != strconv.Itoa(*port) {
		// Vite's /ws proxy targets one fixed port, so a fallback port would
		// leave the dev UI talking to whatever holds the requested one.
		cancel()
		_ = srv.Wait()
		fmt.Fprintf(stderr, "orion: port %d is in use; --dev does not fall back to another port, as Vite proxies /ws to this one\n", *port)
		return 1
	}
	fmt.Fprintf(stdout, "orion %s serving %s\n  %s\n", version.Version, eng.Snapshot().Repo.Name, srv.URL)
	if *dev {
		fmt.Fprintf(stdout, "  dev UI (Vite): http://localhost:%d/?t=%s\n", server.VitePort, u.Query().Get("t"))
	}
	if !*noOpen && !*dev {
		if err := openBrowser(srv.URL); err != nil {
			fmt.Fprintln(stderr, "orion: could not open a browser:", err)
		}
	}

	runErr := make(chan error, 1)
	go func() { runErr <- eng.Run(ctx) }()
	var engErr error
	select {
	case <-ctx.Done(): // Ctrl-C / SIGTERM
		stop() // a second Ctrl-C kills the process if shutdown stalls
		engErr = <-runErr
	case engErr = <-runErr: // the engine failed on its own
		cancel()
	}
	srvErr := srv.Wait() // every client has been sent a close frame
	for _, err := range []error{engErr, srvErr} {
		if err != nil {
			fmt.Fprintln(stderr, "orion:", firstLine(err))
			return 1
		}
	}
	return 0
}

// loadToken returns the stored token, or "" (a random token for this run
// only) with a warning if it cannot be read or created.
func loadToken(stderr io.Writer) string {
	path, err := tokenPath()
	if err == nil {
		var tok string
		if tok, err = server.LoadToken(path); err == nil {
			return tok
		}
	}
	fmt.Fprintln(stderr, "orion: using a one-off URL, as the saved token is unavailable:", firstLine(err))
	return ""
}

func firstLine(err error) string {
	s, _, _ := strings.Cut(err.Error(), "\n")
	return s
}

// openBrowser opens url with the platform's opener, without waiting for it.
// Tests replace it.
var openBrowser = func(url string) error {
	cmd, err := browserCommand(url)
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// browserCommand builds the platform's opener for url, in its own process
// group so a Ctrl-C at orion's terminal does not reach it.
func browserCommand(url string) (*exec.Cmd, error) {
	var name string
	switch runtime.GOOS {
	case "darwin":
		name = "open"
	case "linux":
		name = "xdg-open"
	default:
		return nil, fmt.Errorf("unsupported platform %s", runtime.GOOS)
	}
	cmd := exec.Command(name, url)
	procgroup.Isolate(cmd)
	return cmd, nil
}

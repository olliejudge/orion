package gitx

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
)

// touchedMarker opens each commit's header line in LogTouched's format
// output. It starts with a control byte no path can contain, so a header is
// never mistaken for a path (or vice versa) while scanning the NUL-separated
// stream that --name-only -z produces.
const touchedMarker = "\x01orion\x01"

// LogTouched returns, for paths touched within rev (a single commit, meaning
// its full ancestry, or an "old..new" range), the committer time (unix
// seconds, git's %ct) of the newest commit that touched each one. History is
// walked newest-first, so the first commit seen for a path wins. Renames are
// not followed (--no-renames): a path's time only comes from commits that
// touched it under that exact name. Merge commits contribute no paths,
// matching plain `git log --name-only` without -m/-c/--cc.
//
// When want is non-nil, reading stops as soon as every path in want has a
// time, bounding a full-history walk to roughly the size of want rather than
// the whole log. A caller that cannot bound the paths in advance (e.g. an
// incremental range that is already small) passes a nil want.
func LogTouched(ctx context.Context, r Runner, dir, rev string, want map[string]bool) (map[string]int64, error) {
	if err := refuseOption(rev); err != nil {
		return nil, err
	}
	if want != nil && len(want) == 0 {
		return map[string]int64{}, nil
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := r.command(ctx, dir, "log", "--format="+touchedMarker+"%ct", "--name-only", "--no-renames", "-z", rev, "--")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	out := map[string]int64{}
	remaining := len(want)
	var ct int64
	haveCt := false
	stopped := false

	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	sc.Split(splitNUL)
	for sc.Scan() {
		tok := sc.Bytes()
		if rest, ok := bytes.CutPrefix(tok, []byte(touchedMarker)); ok {
			n, perr := strconv.ParseInt(string(rest), 10, 64)
			if perr != nil {
				cancel()
				_ = cmd.Wait()
				return nil, fmt.Errorf("git log (in %s): bad committer time %q", dir, rest)
			}
			ct, haveCt = n, true
			continue
		}
		if !haveCt {
			continue // stray output before the first header: ignore
		}
		path := string(bytes.TrimPrefix(tok, []byte("\n")))
		if path == "" {
			continue
		}
		if _, ok := out[path]; !ok {
			out[path] = ct
			if want != nil && want[path] {
				remaining--
			}
		}
		if want != nil && remaining <= 0 {
			stopped = true
			break
		}
	}
	scanErr := sc.Err()

	if stopped {
		cancel() // we have everything we need; stop the walk early
		_ = cmd.Wait()
		return out, nil
	}
	if werr := cmd.Wait(); werr != nil {
		if scanErr != nil {
			werr = scanErr
		}
		return nil, fmt.Errorf("git log (in %s): %w: %s", dir, werr, strings.TrimSpace(stderr.String()))
	}
	if scanErr != nil {
		return nil, fmt.Errorf("git log (in %s): %w", dir, scanErr)
	}
	return out, nil
}

// splitNUL is a bufio.SplitFunc that splits on NUL bytes, the way
// bufio.ScanLines splits on '\n'.
func splitNUL(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexByte(data, 0); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

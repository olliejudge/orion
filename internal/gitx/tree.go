package gitx

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
)

// FileEntry is one file of a tree. Submodules have Size 0.
type FileEntry struct {
	Path string
	Size int64
}

// LsTree lists every file in rev's tree (recursively, whole repo even when
// dir is a subdirectory). An empty rev (unborn repo) yields nil.
func LsTree(ctx context.Context, r Runner, dir, rev string) ([]FileEntry, error) {
	if rev == "" {
		return nil, nil
	}
	if err := refuseOption(rev); err != nil {
		return nil, err
	}
	out, err := r.Run(ctx, dir, "ls-tree", "-r", "-l", "-z", "--full-tree", rev)
	if err != nil {
		return nil, err
	}
	return parseLsTree(out)
}

// parseLsTree parses records "<mode> <type> <object> <size>\t<path>\x00";
// size is space-padded and "-" for submodules (type "commit").
func parseLsTree(out []byte) ([]FileEntry, error) {
	var entries []FileEntry
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		meta, path, ok := bytes.Cut(rec, []byte{'\t'})
		if !ok {
			return nil, fmt.Errorf("ls-tree: malformed record %q", rec)
		}
		fields := strings.Fields(string(meta))
		if len(fields) != 4 {
			return nil, fmt.Errorf("ls-tree: malformed metadata %q", meta)
		}
		var size int64
		if fields[1] == "blob" {
			n, err := strconv.ParseInt(fields[3], 10, 64)
			if err != nil {
				return nil, fmt.Errorf("ls-tree: bad size in %q: %w", meta, err)
			}
			size = n
		}
		entries = append(entries, FileEntry{Path: string(path), Size: size})
	}
	return entries, nil
}

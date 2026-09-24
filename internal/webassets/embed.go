// Package webassets embeds the built frontend. When the UI has not been built
// (static/ holds only .gitkeep), it serves fallback.html as index.html so that
// `go build` and `go test` work without Node.
package webassets

import (
	"embed"
	"io/fs"
	"testing/fstest"
)

//go:embed all:static
var static embed.FS

//go:embed fallback.html
var fallbackHTML []byte

// FS returns the files to serve at "/". It always contains index.html.
func FS() fs.FS {
	sub, err := fs.Sub(static, "static")
	if err != nil {
		panic(err) // "static" is a compile-time constant directory; cannot fail
	}
	return pick(sub)
}

// HasUI reports whether the real web UI was embedded at build time.
func HasUI() bool {
	_, err := fs.Stat(static, "static/index.html")
	return err == nil
}

func pick(built fs.FS) fs.FS {
	if _, err := fs.Stat(built, "index.html"); err == nil {
		return built
	}
	return fstest.MapFS{"index.html": {Data: fallbackHTML, Mode: 0o444}}
}

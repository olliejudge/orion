package main

import (
	"bytes"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// The demo project is "nebula", an invented star-catalogue service. Nothing
// here is copied from any real repository.

var words = []string{
	"star", "orbit", "comet", "nova", "quasar", "pulsar", "photon", "lens", "sky",
	"chart", "tile", "index", "query", "cache", "session", "token", "observer",
	"telescope", "filter", "export", "import", "sync", "metric", "alert", "feed",
	"search", "route", "schema", "render", "parallax", "redshift", "magnitude",
	"ephemeris", "epoch", "horizon", "zenith", "azimuth", "catalog", "survey",
	"cluster", "galaxy", "spectrum", "flux", "transit", "eclipse",
}

// area is one folder of the synthetic project.
type area struct {
	Dir   string // repo-relative, slash-separated
	Ext   string // extension of files created here
	Count int    // files in the initial project
	Scope string // conventional-commit scope
}

var areas = []area{
	{"cmd/nebula", ".go", 4, "cli"},
	{"cmd/nebula-migrate", ".go", 2, "cli"},
	{"internal/api", ".go", 18, "api"},
	{"internal/store", ".go", 14, "store"},
	{"internal/store/migrations", ".sql", 10, "store"},
	{"internal/catalog", ".go", 14, "catalog"},
	{"internal/auth", ".go", 10, "auth"},
	{"internal/telemetry", ".go", 8, "telemetry"},
	{"pkg/starmath", ".go", 8, "starmath"},
	{"web/src/components", ".tsx", 30, "ui"},
	{"web/src/components/styles", ".css", 8, "ui"},
	{"web/src/pages", ".tsx", 12, "pages"},
	{"web/src/hooks", ".ts", 8, "ui"},
	{"web/src/lib", ".ts", 10, "ui"},
	{"web/public/img", ".png", 8, "ui"},
	{"web/public/icons", ".svg", 6, "ui"},
	{"docs", ".md", 5, "docs"},
	{"docs/guides", ".md", 10, "docs"},
	{"docs/adr", ".md", 8, "docs"},
	{"deploy/k8s", ".yaml", 8, "deploy"},
	{"deploy/terraform", ".tf", 6, "deploy"},
	{"scripts", ".sh", 5, "build"},
	{"testdata/fixtures", ".json", 12, "test"},
}

var rootFiles = []string{
	"README.md", "LICENSE", "Makefile", "go.mod", "go.sum", ".gitignore",
	".editorconfig", "Dockerfile", "docker-compose.yaml",
	"web/package.json", "web/tsconfig.json", "web/vite.config.ts", "web/index.html",
}

const historyCommits = 40

// historyStart is fixed so that the same seed always yields the same SHAs.
var historyStart = time.Date(2026, 1, 5, 9, 0, 0, 0, time.UTC)

func areaFor(dir string) (area, bool) {
	for _, a := range areas {
		if a.Dir == dir {
			return a, true
		}
	}
	return area{}, false
}

func scopeFor(rel string) string {
	best := ""
	scope := "repo"
	for _, a := range areas {
		if strings.HasPrefix(rel, a.Dir+"/") && len(a.Dir) > len(best) {
			best, scope = a.Dir, a.Scope
		}
	}
	return scope
}

func pascal(w string) string { return strings.ToUpper(w[:1]) + w[1:] }

// namer invents unique, convention-following file names.
type namer struct {
	rng   *rand.Rand
	taken map[string]bool
	seq   map[string]int
}

func newNamer(rng *rand.Rand) *namer {
	return &namer{rng: rng, taken: map[string]bool{}, seq: map[string]int{}}
}

// next returns an unused repo-relative path for a new file in dir with ext.
// exists (may be nil) reports whether a candidate already exists on disk.
func (n *namer) next(dir, ext string, exists func(rel string) bool) string {
	for {
		w1 := words[n.rng.IntN(len(words))]
		w2 := words[n.rng.IntN(len(words))]
		if w1 == w2 {
			continue
		}
		var base string
		switch ext {
		case ".go":
			base = w1 + "_" + w2
			if n.rng.IntN(4) == 0 {
				base += "_test"
			}
		case ".tsx":
			base = pascal(w1) + pascal(w2)
		case ".css":
			base = pascal(w1) + pascal(w2) + ".module"
		case ".ts":
			if strings.HasSuffix(dir, "hooks") {
				base = "use" + pascal(w1) + pascal(w2)
			} else {
				base = w1 + pascal(w2)
			}
		case ".sql":
			n.seq[dir]++
			base = fmt.Sprintf("%04d_create_%s_%s", n.seq[dir], w1, w2)
		default:
			base = w1 + "-" + w2
		}
		rel := path.Join(dir, base+ext)
		if n.taken[rel] || (exists != nil && exists(rel)) {
			continue
		}
		n.taken[rel] = true
		return rel
	}
}

// sizeFor picks a target size in bytes, skewed towards small files.
func sizeFor(ext string, rng *rand.Rand) int {
	lo, hi := 200, 2500
	switch ext {
	case ".go":
		lo, hi = 400, 6000
	case ".tsx":
		lo, hi = 300, 4000
	case ".css", ".sh", ".sql":
		lo, hi = 150, 1500
	case ".md":
		lo, hi = 500, 9000
	case ".json":
		lo, hi = 300, 8000
		if rng.IntN(10) == 0 {
			lo, hi = 60000, 160000
		}
	case ".png":
		lo, hi = 2000, 60000
	}
	return lo + int(float64(hi-lo)*math.Pow(rng.Float64(), 2))
}

func header(rel string) string {
	ext := path.Ext(rel)
	name := strings.TrimSuffix(path.Base(rel), ext)
	switch ext {
	case ".go":
		pkg := strings.ReplaceAll(path.Base(path.Dir(rel)), "-", "")
		if strings.HasPrefix(rel, "cmd/") {
			pkg = "main"
		}
		return "package " + pkg + "\n"
	case ".tsx", ".ts":
		return "import { useMemo } from \"react\";\n"
	case ".md":
		return "# " + strings.ReplaceAll(name, "-", " ") + "\n"
	case ".sql":
		return "-- migration " + name + "\n"
	case ".sh":
		return "#!/usr/bin/env bash\nset -euo pipefail\n"
	case ".yaml":
		return "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: nebula-" + name + "\n"
	case ".svg":
		return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">\n"
	case ".json":
		return "[\n"
	}
	return ""
}

func footer(ext string) string {
	switch ext {
	case ".svg":
		return "</svg>\n"
	case ".json":
		return "  {}\n]\n"
	}
	return ""
}

// line returns one plausible chunk of text for a file with extension ext.
func line(ext string, rng *rand.Rand) string {
	w1 := words[rng.IntN(len(words))]
	w2 := words[rng.IntN(len(words))]
	k := rng.IntN(97) + 2
	switch ext {
	case ".go":
		return fmt.Sprintf("\n// %s%s returns the %s %s for n.\nfunc %s%s%d(n int) int {\n\treturn n * %d\n}\n", pascal(w1), pascal(w2), w1, w2, pascal(w1), pascal(w2), k, k)
	case ".tsx":
		return fmt.Sprintf("\nexport function %s%s%d() {\n  const v = useMemo(() => %d, []);\n  return <div className=\"%s-%s\">{v}</div>;\n}\n", pascal(w1), pascal(w2), k, k, w1, w2)
	case ".ts":
		return fmt.Sprintf("\nexport const %s%s%d = (n: number): number => n * %d;\n", w1, pascal(w2), k, k)
	case ".css":
		return fmt.Sprintf(".%s-%s { margin: %dpx; opacity: 0.%d; }\n", w1, w2, k%24, k%10)
	case ".md":
		return fmt.Sprintf("\nThe %s keeps a %s of every %s so that %s queries stay fast (%d ms budget).\n", w1, w2, words[rng.IntN(len(words))], w1, k)
	case ".sql":
		return fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s_%s_%d (id BIGINT PRIMARY KEY, %s TEXT NOT NULL);\n", w1, w2, k, w2)
	case ".yaml":
		return fmt.Sprintf("  # %s %s\n  %s%d: \"%d\"\n", w1, w2, w1, k, k)
	case ".tf":
		return fmt.Sprintf("\nresource \"nebula_%s\" \"%s_%d\" {\n  size = %d\n}\n", w1, w2, k, k)
	case ".sh":
		return fmt.Sprintf("echo \"%s %s %d\"\n", w1, w2, k)
	case ".json":
		return fmt.Sprintf("  {\"id\": %d, \"name\": \"%s-%s\", \"magnitude\": %d.%d},\n", rng.IntN(1_000_000), w1, w2, k%7, k%10)
	case ".svg":
		return fmt.Sprintf("  <circle cx=\"%d\" cy=\"%d\" r=\"%d\"/>\n", k%64, (k*7)%64, k%9+1)
	case ".png":
		b := make([]byte, 256)
		for i := range b {
			b[i] = byte(rng.UintN(256))
		}
		return string(b)
	}
	return fmt.Sprintf("# %s %s %d\n", w1, w2, k)
}

// content generates a whole file for rel.
func content(rel string, rng *rand.Rand) []byte {
	ext := path.Ext(rel)
	target := sizeFor(ext, rng)
	var b bytes.Buffer
	if ext == ".png" {
		b.WriteString("\x89PNG\r\n\x1a\n")
	} else {
		b.WriteString(header(rel))
	}
	for b.Len() < target {
		b.WriteString(line(ext, rng))
	}
	b.WriteString(footer(ext))
	return b.Bytes()
}

func rootContent(rel string) []byte {
	switch rel {
	case "README.md":
		return []byte("# nebula\n\nA tiny self-hosted star catalogue. (Synthetic demo project for orion.)\n")
	case "LICENSE":
		return []byte("MIT License\n\nCopyright (c) 2026 The Nebula Authors (fictional)\n")
	case "Makefile":
		return []byte(".PHONY: build test\nbuild:\n\tgo build ./...\ntest:\n\tgo test ./...\n")
	case "go.mod":
		return []byte("module example.invalid/nebula\n\ngo 1.27\n")
	case "go.sum":
		return []byte("")
	case ".gitignore":
		return []byte("/bin/\nnode_modules/\ndist/\n.claude/worktrees/\n")
	case ".editorconfig":
		return []byte("root = true\n\n[*]\nindent_style = tab\n")
	case "Dockerfile":
		return []byte("FROM golang:1.27 AS build\nWORKDIR /src\nCOPY . .\nRUN go build -o /nebula ./cmd/nebula\n")
	case "docker-compose.yaml":
		return []byte("services:\n  nebula:\n    build: .\n    ports: [\"8080:8080\"]\n")
	case "web/package.json":
		return []byte("{\n  \"name\": \"nebula-web\",\n  \"private\": true,\n  \"type\": \"module\"\n}\n")
	case "web/tsconfig.json":
		return []byte("{\n  \"compilerOptions\": { \"strict\": true, \"jsx\": \"react-jsx\" }\n}\n")
	case "web/vite.config.ts":
		return []byte("import { defineConfig } from \"vite\";\n\nexport default defineConfig({});\n")
	case "web/index.html":
		return []byte("<!doctype html>\n<title>nebula</title>\n<div id=\"root\"></div>\n")
	}
	return []byte("\n")
}

func writeFile(root, rel string, data []byte) error {
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

func appendFile(root, rel string, data string) error {
	f, err := os.OpenFile(filepath.Join(root, filepath.FromSlash(rel)), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(data); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// buildRepo initialises root as a git repo on main and writes a synthetic
// history of historyCommits commits. The same rng seed gives identical SHAs.
func buildRepo(root string, rng *rand.Rand, nm *namer, log *logger) error {
	if _, err := git(root, nil, "init", "-q", "-b", "main"); err != nil {
		return err
	}
	var planned []string
	for _, a := range areas {
		for i := 0; i < a.Count; i++ {
			planned = append(planned, nm.next(a.Dir, a.Ext, nil))
		}
	}
	for _, rel := range rootFiles {
		nm.taken[rel] = true
		if err := writeFile(root, rel, rootContent(rel)); err != nil {
			return err
		}
	}
	firstBatch := len(planned) * 3 / 10
	var present []string
	for _, rel := range planned[:firstBatch] {
		if err := writeFile(root, rel, content(rel, rng)); err != nil {
			return err
		}
		present = append(present, rel)
	}
	when := historyStart
	if _, err := commitAll(root, human, when, "chore: scaffold nebula"); err != nil {
		return err
	}
	pool := planned[firstBatch:]
	for i := 1; i < historyCommits; i++ {
		when = when.Add(time.Duration(3+rng.IntN(20)) * time.Hour)
		left := historyCommits - i
		take := (len(pool) + left - 1) / left
		batch := pool[:take]
		pool = pool[take:]
		var msg string
		for _, rel := range batch {
			if err := writeFile(root, rel, content(rel, rng)); err != nil {
				return err
			}
		}
		switch {
		case i%9 == 0 && len(present) > 0:
			j := rng.IntN(len(present))
			old := present[j]
			renamed := nm.next(path.Dir(old), path.Ext(old), nil)
			if err := os.Rename(filepath.Join(root, filepath.FromSlash(old)), filepath.Join(root, filepath.FromSlash(renamed))); err != nil {
				return err
			}
			present[j] = renamed
			msg = fmt.Sprintf("refactor(%s): rename %s to %s", scopeFor(old), path.Base(old), path.Base(renamed))
		case len(batch) > 0:
			msg = fmt.Sprintf("feat(%s): add %s", scopeFor(batch[0]), strings.TrimSuffix(path.Base(batch[0]), path.Ext(batch[0])))
			if len(batch) > 1 {
				msg += fmt.Sprintf(" and %d more", len(batch)-1)
			}
		default:
			msg = "chore: tidy"
		}
		for k := 0; k < 1+rng.IntN(3) && len(present) > 0; k++ {
			rel := present[rng.IntN(len(present))]
			if err := appendFile(root, rel, line(path.Ext(rel), rng)); err != nil {
				return err
			}
		}
		present = append(present, batch...)
		if _, err := commitAll(root, human, when, msg); err != nil {
			return err
		}
	}
	log.printf("created nebula with %d files and %d commits on main", len(present)+len(rootFiles), historyCommits)
	return nil
}

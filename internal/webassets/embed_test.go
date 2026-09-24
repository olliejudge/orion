package webassets

import (
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

func TestPickUsesBuiltUIWhenIndexExists(t *testing.T) {
	built := fstest.MapFS{
		"index.html":    {Data: []byte("<html>real ui</html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	got := pick(built)
	b, err := fs.ReadFile(got, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "<html>real ui</html>" {
		t.Fatalf("index.html = %q, want the built UI", b)
	}
	if _, err := fs.Stat(got, "assets/app.js"); err != nil {
		t.Fatalf("assets/app.js missing: %v", err)
	}
}

func TestPickFallsBackWithoutIndex(t *testing.T) {
	onlyKeep := fstest.MapFS{".gitkeep": {Data: nil}}
	got := pick(onlyKeep)
	b, err := fs.ReadFile(got, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "make web") {
		t.Fatalf("fallback index.html should tell the user to run make web, got %q", b)
	}
}

func TestFSAlwaysServesIndex(t *testing.T) {
	b, err := fs.ReadFile(FS(), "index.html")
	if err != nil {
		t.Fatalf("FS() has no index.html: %v", err)
	}
	if HasUI() == strings.Contains(string(b), "make web") {
		t.Fatalf("HasUI() = %v but index.html fallback-ness disagrees", HasUI())
	}
}

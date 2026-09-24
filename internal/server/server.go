// Package server serves the embedded UI and streams model patches over a
// WebSocket, guarded by a per-run token and Host/Origin checks.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/olliejudge/orion/internal/model"
)

const cookieName = "orion_t"

// VitePort is the Vite dev server's port. With Options.Dev the browser page
// comes from there and Vite proxies /ws to us, so its origin is allowed too.
const VitePort = 5173

// builtinFallback is served when Assets has neither index.html nor fallback.html.
const builtinFallback = `<!doctype html><meta charset="utf-8"><title>orion</title>` +
	`<p>The orion UI is not built. Run <code>make web</code> and rebuild.</p>`

// Source is what the server streams: a snapshot plus a patch subscription.
type Source interface {
	Snapshot() model.Snapshot
	Subscribe() (<-chan model.Patch, func())
}

// Options configures Start. Port 0 picks any free port. Dev serves only /ws
// (Vite serves the UI on VitePort and proxies /ws). Assets is the built UI;
// when it has no index.html, its fallback.html (or a built-in page) is served.
type Options struct {
	Port   int
	Dev    bool
	Assets fs.FS
}

// Server is a running orion HTTP server.
type Server struct {
	URL string // http://127.0.0.1:PORT/?t=TOKEN

	ctx      context.Context
	src      Source
	opt      Options
	port     string
	token    string
	hasUI    bool
	fallback []byte
	http     *http.Server
	done     chan struct{}
	err      error

	mu      sync.Mutex
	closing bool
	conns   sync.WaitGroup
}

// Start listens on 127.0.0.1 (with port fallback) and serves until ctx is done.
func Start(ctx context.Context, src Source, opt Options) (*Server, error) {
	ln, err := listen(opt.Port)
	if err != nil {
		return nil, err
	}
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("generate token: %w", err)
	}
	s := &Server{
		ctx:   ctx,
		src:   src,
		opt:   opt,
		port:  strconv.Itoa(ln.Addr().(*net.TCPAddr).Port),
		token: hex.EncodeToString(tok),
		done:  make(chan struct{}),
	}
	s.URL = "http://127.0.0.1:" + s.port + "/?t=" + s.token
	s.hasUI, s.fallback = inspectAssets(opt.Assets)
	s.http = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() {
		err := s.http.Serve(ln)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		s.err = err
		s.markClosing()
		close(s.done)
	}()
	go func() {
		<-ctx.Done()
		s.markClosing()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.http.Shutdown(sctx)
	}()
	return s, nil
}

// Wait blocks until the server has stopped and every WebSocket has closed.
func (s *Server) Wait() error {
	<-s.done
	s.conns.Wait()
	return s.err
}

func (s *Server) markClosing() {
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
}

func inspectAssets(a fs.FS) (bool, []byte) {
	if a != nil {
		if _, err := fs.Stat(a, "index.html"); err == nil {
			return true, nil
		}
		if b, err := fs.ReadFile(a, "fallback.html"); err == nil {
			return false, b
		}
	}
	return false, []byte(builtinFallback)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !s.loopback(r.Host) {
		http.Error(w, "forbidden host", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/" && s.validToken(r.URL.Query().Get("t")) {
		http.SetCookie(w, &http.Cookie{
			Name: cookieName, Value: s.token, Path: "/",
			HttpOnly: true, SameSite: http.SameSiteStrictMode,
		})
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	switch {
	case r.URL.Path == "/ws":
		s.serveWS(w, r)
	case s.opt.Dev:
		http.Error(w, "orion --dev: the UI is served by the Vite dev server", http.StatusNotFound)
	default:
		s.serveStatic(w, r)
	}
}

func (s *Server) validToken(t string) bool {
	return t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

func (s *Server) authorized(r *http.Request) bool {
	if s.validToken(r.URL.Query().Get("t")) {
		return true
	}
	c, err := r.Cookie(cookieName)
	return err == nil && s.validToken(c.Value)
}

// loopback reports whether hostport is 127.0.0.1:PORT or localhost:PORT, or
// (Dev only) the same hosts on VitePort.
func (s *Server) loopback(hostport string) bool {
	h, p, err := net.SplitHostPort(hostport)
	if err != nil || (h != "127.0.0.1" && h != "localhost") {
		return false
	}
	return p == s.port || (s.opt.Dev && p == strconv.Itoa(VitePort))
}

func (s *Server) originOK(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Path != "" || u.RawQuery != "" || u.User != nil {
		return false
	}
	return s.loopback(u.Host)
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.hasUI {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(s.fallback)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if fi, err := fs.Stat(s.opt.Assets, name); err != nil || fi.IsDir() {
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		name = "index.html" // SPA route
	}
	http.ServeFileFS(w, r, s.opt.Assets, name)
}

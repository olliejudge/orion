package server

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const writeTimeout = 10 * time.Second

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	if !s.originOK(r.Header.Get("Origin")) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}
	s.conns.Add(1)
	s.mu.Unlock()
	defer s.conns.Done()

	// Origin was verified above against the exact loopback host:port; the
	// library's own same-host check would reject Vite's origin in --dev.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()
	s.stream(c)
}

// stream sends a snapshot, then every newer patch, until the client goes away
// or the server shuts down. {"type":"resync"} from the client, or the source
// dropping our subscription, triggers a fresh snapshot.
func (s *Server) stream(c *websocket.Conn) {
	resync := make(chan struct{}, 1)
	gone := make(chan struct{})
	defer func() { <-gone }() // runs after stopRead: Wait also covers the reader
	readCtx, stopRead := context.WithCancel(context.Background())
	defer stopRead()
	go func() {
		defer close(gone)
		for {
			var m struct {
				Type string `json:"type"`
			}
			if err := wsjson.Read(readCtx, c, &m); err != nil {
				return
			}
			if m.Type == "resync" {
				select {
				case resync <- struct{}{}:
				default:
				}
			}
		}
	}()

	ch, unsub := s.src.Subscribe()
	defer func() { unsub() }()
	last, err := s.sendSnapshot(c)
	if err != nil {
		return
	}
	for {
		select {
		case <-s.ctx.Done():
			_ = c.Close(websocket.StatusGoingAway, "orion is shutting down")
			return
		case <-gone:
			return
		case <-resync:
			if last, err = s.sendSnapshot(c); err != nil {
				return
			}
		case p, ok := <-ch:
			if !ok { // dropped as a slow subscriber: start over
				unsub()
				ch, unsub = s.src.Subscribe()
				if last, err = s.sendSnapshot(c); err != nil {
					return
				}
				continue
			}
			if p.Seq <= last {
				continue // already covered by the snapshot we sent
			}
			if err := write(c, p); err != nil {
				return
			}
			last = p.Seq
		}
	}
}

func (s *Server) sendSnapshot(c *websocket.Conn) (uint64, error) {
	snap := s.src.Snapshot()
	return snap.Seq, write(c, snap)
}

func write(c *websocket.Conn, v any) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return wsjson.Write(ctx, c, v)
}

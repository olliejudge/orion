// Package watch turns the OS file-watching API into a stream of absolute
// paths: FSEvents on darwin, recursive inotify (via fsnotify) on linux. It
// knows nothing about git.
package watch

// Event is one filesystem change. Path is absolute and symlink-resolved.
// Rescan is true when the OS dropped or coalesced events under Path (the
// watched root on linux): the consumer must recompute everything there.
type Event struct {
	Path   string
	Rescan bool
}

// Watcher watches directory trees recursively.
//
// Add's error and every error on Errors is an *fs.PathError naming the
// affected directory where one is known. Errors never blocks the watcher: an
// error that cannot be buffered becomes a Rescan event for its root instead.
type Watcher interface {
	Events() <-chan Event
	Errors() <-chan error
	Add(root string) error // watch a root recursively (idempotent)
	Remove(root string) error
	Close() error // stops all watches and closes Events and Errors
}

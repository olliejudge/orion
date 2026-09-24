// Package version holds the build version, set at link time with
// -ldflags "-X github.com/olliejudge/orion/internal/version.Version=1.2.3".
// Both GoReleaser and `make build` write it without a leading "v".
package version

// Version is "dev" for a plain `go build`; `make build` and release builds
// overwrite it via ldflags.
var Version = "dev"

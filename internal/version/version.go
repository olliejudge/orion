// Package version holds the build version, set at link time with
// -ldflags "-X github.com/olliejudge/orion/internal/version.Version=v1.2.3".
package version

// Version is "dev" for local builds; release builds overwrite it via ldflags.
var Version = "dev"

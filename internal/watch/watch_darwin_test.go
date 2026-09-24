//go:build darwin

package watch

import (
	"testing"

	"github.com/fsnotify/fsevents"
)

func TestConvertDarwin(t *testing.T) {
	tests := []struct {
		in     fsevents.Event
		want   Event
		wantOK bool
	}{
		{fsevents.Event{Path: "/r/a.txt", Flags: fsevents.ItemCreated | fsevents.ItemIsFile}, Event{Path: "/r/a.txt"}, true},
		{fsevents.Event{Path: "r/dir/", Flags: fsevents.ItemModified}, Event{Path: "/r/dir"}, true},
		{fsevents.Event{Path: "/r", Flags: fsevents.MustScanSubDirs}, Event{Path: "/r", Rescan: true}, true},
		{fsevents.Event{Path: "/r", Flags: fsevents.MustScanSubDirs | fsevents.UserDropped}, Event{Path: "/r", Rescan: true}, true},
		{fsevents.Event{Path: "/r", Flags: fsevents.KernelDropped}, Event{Path: "/r", Rescan: true}, true},
		{fsevents.Event{Path: "/r", Flags: fsevents.HistoryDone}, Event{}, false},
	}
	for _, tt := range tests {
		got, ok := convert(tt.in)
		if ok != tt.wantOK || got != tt.want {
			t.Errorf("convert(%+v) = %+v, %v; want %+v, %v", tt.in, got, ok, tt.want, tt.wantOK)
		}
	}
}

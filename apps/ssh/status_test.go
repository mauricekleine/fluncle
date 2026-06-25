package main

import (
	"errors"
	"strings"
	"testing"
)

// statusMsg folds the /api/v1/status report into the model and lands the status
// screen, clearing the loading flag.
func TestStatusMsgSetsReport(t *testing.T) {
	base := newModel(&app{}, 80, 24)
	base.screen = screenStatus
	base.loading = true

	report := &statusReport{
		GeneratedAt: "2026-06-25T06:11:06Z",
		Services: []serviceStatus{
			{Service: "web", Status: "ok", Message: "200 in 733ms", Since: "2026-06-24T15:34:43Z"},
		},
	}
	updated, _ := base.Update(statusMsg{report: report})
	m := updated.(model)

	if m.loading {
		t.Error("statusMsg left loading set")
	}
	if m.status == nil || len(m.status.Services) != 1 {
		t.Fatal("statusMsg did not set the report")
	}
}

// A failed report surfaces the error, leaves the report nil, and clears loading.
func TestStatusMsgError(t *testing.T) {
	base := newModel(&app{}, 80, 24)
	base.screen = screenStatus
	base.loading = true

	updated, _ := base.Update(statusMsg{err: errors.New("status probe failed")})
	m := updated.(model)

	if m.loading {
		t.Error("error statusMsg left loading set")
	}
	if m.status != nil {
		t.Error("error statusMsg set a report")
	}
	if m.err == "" {
		t.Error("error statusMsg did not surface an error")
	}
}

// The board renders each service's voice label, a recovered state word, the
// since field, and the probe message — in the recovered-instrument register
// (no exclamation marks, VOICE.md §6).
func TestRenderStatusBoard(t *testing.T) {
	m := newModel(&app{}, 80, 24)
	m.screen = screenStatus
	m.status = &statusReport{
		GeneratedAt: "2026-06-25T06:11:06Z",
		Services: []serviceStatus{
			{Service: "web", Status: "ok", Message: "200 in 733ms", Since: "2026-06-22T06:11:06Z"},
			{Service: "onion", Status: "down", Message: "unreachable", Since: "2026-06-25T05:11:06Z"},
		},
	}

	out := m.renderStatus()
	for _, want := range []string{"Web", "operational", "up 3d", "Tor onion", "down 1h", "200 in 733ms"} {
		if !strings.Contains(out, want) {
			t.Errorf("status board missing %q\n%s", want, out)
		}
	}
	// A down service drives the overall headline.
	if !strings.Contains(out, "Some services are down") {
		t.Errorf("down service did not set the headline\n%s", out)
	}
	if strings.Contains(out, "!") {
		t.Errorf("status board contains an exclamation mark (VOICE.md)\n%s", out)
	}
}

// An empty report reads as a quiet sector, not a crash.
func TestRenderStatusEmpty(t *testing.T) {
	m := newModel(&app{}, 80, 24)
	m.screen = screenStatus
	m.status = &statusReport{GeneratedAt: "2026-06-25T06:11:06Z"}

	out := m.renderStatus()
	if !strings.Contains(out, "Quiet sector") {
		t.Errorf("empty report did not read as a quiet sector\n%s", out)
	}
}

// Services sort by the fixed order (web leads, render-box trails); an unknown
// service falls in after the ranked ones.
func TestSortServiceStatuses(t *testing.T) {
	ordered := sortServiceStatuses([]serviceStatus{
		{Service: "render-box"},
		{Service: "mystery"},
		{Service: "web"},
		{Service: "ssh"},
	})
	got := make([]string, 0, len(ordered))
	for _, service := range ordered {
		got = append(got, service.Service)
	}
	want := []string{"web", "ssh", "render-box", "mystery"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("sort order = %v, want %v", got, want)
	}
}

// The since humanizer tunes the verb to the status and reads whole-unit elapsed.
func TestHumanizeServiceSince(t *testing.T) {
	now := "2026-06-25T12:00:00Z"
	cases := []struct {
		since  string
		status string
		want   string
	}{
		{since: "2026-06-22T12:00:00Z", status: "ok", want: "up 3d"},
		{since: "2026-06-25T11:00:00Z", status: "down", want: "down 1h"},
		{since: "2026-06-25T11:45:00Z", status: "degraded", want: "degraded 15m"},
		{since: "2026-06-25T11:59:40Z", status: "ok", want: "up just now"},
	}
	for _, tc := range cases {
		if got := humanizeServiceSince(tc.since, now, tc.status); got != tc.want {
			t.Errorf("humanizeServiceSince(%q, %q) = %q, want %q", tc.since, tc.status, got, tc.want)
		}
	}
}

// The state word maps the three-state enum to the terminal's quiet register and
// passes an unknown value through verbatim.
func TestServiceStatusWord(t *testing.T) {
	cases := map[string]string{"ok": "operational", "degraded": "degraded", "down": "down", "mystery": "mystery"}
	for status, want := range cases {
		if got := serviceStatusWord(status); got != want {
			t.Errorf("serviceStatusWord(%q) = %q, want %q", status, got, want)
		}
	}
}

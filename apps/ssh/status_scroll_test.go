package main

import (
	"fmt"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// tallStatusReport synthesizes a report with enough services that the board runs
// past even a roomy terminal — the long `cron.*` list that overflowed before the
// screen learned to scroll.
func tallStatusReport(n int) *statusReport {
	services := make([]serviceStatus, 0, n)
	for i := 0; i < n; i++ {
		services = append(services, serviceStatus{
			Service: fmt.Sprintf("cron.job%02d", i),
			Status:  "ok",
			Message: "ran clean",
			Since:   "2026-06-22T06:11:06Z",
		})
	}
	return &statusReport{GeneratedAt: "2026-06-25T06:11:06Z", Services: services}
}

// The mouse wheel must drive the same scroll as the keyboard on the status
// board, clamped both ways, and do nothing off the status screen (mouse capture
// is off there).
func TestStatusWheelScroll(t *testing.T) {
	m := model{width: 80, height: 24, screen: screenStatus, status: tallStatusReport(20)}
	if m.statusMaxScroll() == 0 {
		t.Fatal("test report is not tall enough to scroll")
	}
	for i := 0; i < 200; i++ {
		updated, _ := m.handleWheel(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
		m = updated.(model)
	}
	if m.scroll != m.statusMaxScroll() {
		t.Errorf("wheel-down scroll %d != max %d", m.scroll, m.statusMaxScroll())
	}
	for i := 0; i < 200; i++ {
		updated, _ := m.handleWheel(tea.MouseWheelMsg{Button: tea.MouseWheelUp})
		m = updated.(model)
	}
	if m.scroll != 0 {
		t.Errorf("wheel-up scroll %d != 0 (top)", m.scroll)
	}

	off := model{width: 80, height: 24, screen: screenMenu, status: tallStatusReport(20)}
	updated, _ := off.handleWheel(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	if updated.(model).scroll != 0 {
		t.Error("wheel should not scroll when off the status screen")
	}
}

// The status board must never render taller than the terminal — the regression
// that prompted scrolling was the long cron.* list running off a default
// session, with the trailing services only reachable after a resize.
func TestStatusFitsViewport(t *testing.T) {
	for _, h := range []int{21, 24, 30, 50} {
		m := model{width: 80, height: h, screen: screenStatus, status: tallStatusReport(24)}
		rendered := pageStyle.Width(clamp(m.width-4, 48, 96)).Render(m.renderStatus())
		if got := lipgloss.Height(rendered); got > h {
			t.Errorf("status board at height %d rendered %d rows (overflows the viewport)", h, got)
		}
	}
}

// Scrolling to the end must reveal the final body line (the trailing cron rows
// that were cut off before).
func TestStatusScrollReachesEnd(t *testing.T) {
	m := model{width: 80, height: 24, screen: screenStatus, status: tallStatusReport(20)}
	updated, _ := m.handleStatusKey("G")
	m = updated.(model)
	body := m.statusBodyLines()
	if end := clamp(m.scroll, 0, m.statusMaxScroll()) + m.statusViewport(); end < len(body) {
		t.Errorf("scrolled to end shows %d of %d body lines; tail unreachable", end, len(body))
	}
}

// Scroll can never run past either end regardless of how many keys arrive.
func TestStatusScrollClamped(t *testing.T) {
	m := model{width: 80, height: 24, screen: screenStatus, status: tallStatusReport(20)}
	for i := 0; i < 200; i++ {
		updated, _ := m.handleStatusKey("down")
		m = updated.(model)
	}
	if m.scroll != m.statusMaxScroll() {
		t.Errorf("scroll %d exceeded max %d", m.scroll, m.statusMaxScroll())
	}
	for i := 0; i < 200; i++ {
		updated, _ := m.handleStatusKey("up")
		m = updated.(model)
	}
	if m.scroll != 0 {
		t.Errorf("scroll %d did not return to top", m.scroll)
	}
}

// q exits the status board back to the menu and resets the scroll offset, so a
// re-entry starts at the top.
func TestStatusKeyExitResetsScroll(t *testing.T) {
	m := model{width: 80, height: 24, screen: screenStatus, status: tallStatusReport(20), scroll: 5}
	updated, _ := m.handleStatusKey("q")
	m = updated.(model)
	if m.screen != screenMenu {
		t.Errorf("q did not return to the menu, screen = %q", m.screen)
	}
	if m.scroll != 0 {
		t.Errorf("q did not reset scroll, got %d", m.scroll)
	}
}

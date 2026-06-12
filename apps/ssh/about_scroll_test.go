package main

import (
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// The mouse wheel must drive the same scroll as the keyboard on About, clamped
// both ways, and do nothing off the About screen (where mouse capture is off).
func TestAboutWheelScroll(t *testing.T) {
	m := model{width: 80, height: 24, screen: screenAbout}
	for i := 0; i < 100; i++ {
		updated, _ := m.handleWheel(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
		m = updated.(model)
	}
	if m.scroll != m.aboutMaxScroll() {
		t.Errorf("wheel-down scroll %d != max %d", m.scroll, m.aboutMaxScroll())
	}
	for i := 0; i < 100; i++ {
		updated, _ := m.handleWheel(tea.MouseWheelMsg{Button: tea.MouseWheelUp})
		m = updated.(model)
	}
	if m.scroll != 0 {
		t.Errorf("wheel-up scroll %d != 0 (top)", m.scroll)
	}

	off := model{width: 80, height: 24, screen: screenMenu}
	updated, _ := off.handleWheel(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	if updated.(model).scroll != 0 {
		t.Error("wheel should not scroll when off the About screen")
	}
}

// The About surface must never render taller than the terminal — the regression
// that prompted scrolling was its full link map running off a default 24-row
// session, with the last links only visible after a resize.
func TestAboutFitsViewport(t *testing.T) {
	for _, h := range []int{21, 24, 30, 50} {
		m := model{width: 80, height: h}
		rendered := pageStyle.Width(clamp(m.width-4, 48, 96)).Render(m.renderAbout())
		if got := lipgloss.Height(rendered); got > h {
			t.Errorf("About at height %d rendered %d rows (overflows the viewport)", h, got)
		}
	}
}

// Scrolling to the end must reveal the final body line (the Source / IP-attribution
// rows that were cut off before).
func TestAboutScrollReachesEnd(t *testing.T) {
	m := model{width: 80, height: 24, screen: screenAbout}
	updated, _ := m.handleAboutKey("G")
	m = updated.(model)
	body := m.aboutBodyLines()
	if end := clamp(m.scroll, 0, m.aboutMaxScroll()) + m.aboutViewport(); end < len(body) {
		t.Errorf("scrolled to end shows %d of %d body lines; tail unreachable", end, len(body))
	}
}

// Scroll can never run past either end regardless of how many keys arrive.
func TestAboutScrollClamped(t *testing.T) {
	m := model{width: 80, height: 24, screen: screenAbout}
	for i := 0; i < 200; i++ {
		updated, _ := m.handleAboutKey("down")
		m = updated.(model)
	}
	if m.scroll != m.aboutMaxScroll() {
		t.Errorf("scroll %d exceeded max %d", m.scroll, m.aboutMaxScroll())
	}
	for i := 0; i < 200; i++ {
		updated, _ := m.handleAboutKey("up")
		m = updated.(model)
	}
	if m.scroll != 0 {
		t.Errorf("scroll %d did not return to top", m.scroll)
	}
}

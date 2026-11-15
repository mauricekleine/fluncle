package main

import (
	"strings"
	"testing"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
)

// A pasted Spotify URL must land in the search field intact — the regression was
// the per-key filter dropping everything that wasn't a single printable ASCII
// rune, so bracketed paste produced nothing.
func TestPasteFillsSearchInput(t *testing.T) {
	m := model{screen: screenSearchInput}
	url := "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"

	updated, _ := m.handlePaste(url)
	m = updated.(model)

	if m.input != url {
		t.Errorf("pasted URL not captured: got %q, want %q", m.input, url)
	}
}

// A paste outside an input screen is ignored (no stray text bleeds into state).
func TestPasteIgnoredOffInputScreen(t *testing.T) {
	m := model{screen: screenMenu}

	updated, _ := m.handlePaste("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")

	if updated.(model).input != "" {
		t.Errorf("paste should be ignored off an input screen, got %q", updated.(model).input)
	}
}

// A multi-line paste strips control characters (newlines, escapes) so the field
// stays single-line and clean.
func TestPasteStripsControlCharacters(t *testing.T) {
	m := model{screen: screenSubscribe}

	updated, _ := m.handlePaste("raver@fluncle.com\n\t")
	m = updated.(model)

	if m.input != "raver@fluncle.com" {
		t.Errorf("control characters not stripped: got %q", m.input)
	}
}

// A printable keypress carries its rune in msg.Text and is appended; a control
// key (empty Text) is dropped.
func TestTypedRuneAppends(t *testing.T) {
	m := model{screen: screenSearchInput}

	updated, _ := m.handleInputKey(tea.KeyPressMsg{Code: 'a', Text: "a"})
	m = updated.(model)
	updated, _ = m.handleInputKey(tea.KeyPressMsg{Code: tea.KeyLeft})
	m = updated.(model)

	if m.input != "a" {
		t.Errorf("typed input got %q, want %q", m.input, "a")
	}
}

// A paste far larger than any field stops at maxInputRunes, and typing past
// the cap adds nothing.
func TestInputStopsAtTheFieldCap(t *testing.T) {
	m := model{screen: screenNoteInput}

	updated, _ := m.handlePaste(strings.Repeat("é", 4<<20))
	m = updated.(model)
	if got := utf8.RuneCountInString(m.input); got != maxInputRunes {
		t.Fatalf("paste kept %d runes, want %d", got, maxInputRunes)
	}

	updated, _ = m.handleInputKey(tea.KeyPressMsg{Code: 'a', Text: "a"})
	m = updated.(model)
	updated, _ = m.handleInputKey(tea.KeyPressMsg{Code: tea.KeySpace, Text: " "})
	m = updated.(model)
	if got := utf8.RuneCountInString(m.input); got != maxInputRunes {
		t.Fatalf("typing past the cap grew the field to %d runes", got)
	}
}

// A paste that fits is kept whole after earlier typing.
func TestPasteBelowTheCapIsKept(t *testing.T) {
	m := model{screen: screenSearchInput, input: "drum "}

	updated, _ := m.handlePaste("and bass")
	if got := updated.(model).input; got != "drum and bass" {
		t.Fatalf("got %q", got)
	}
}

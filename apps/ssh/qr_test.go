package main

import (
	"regexp"
	"strings"
	"testing"

	"github.com/mattn/go-runewidth"
)

// ansiPattern strips the lipgloss/SGR escapes so we can inspect the raw QR
// glyph grid the way a terminal would paint it.
var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func stripANSI(s string) string {
	return ansiPattern.ReplaceAllString(s, "")
}

// The QR beam must encode a finding's real /log page (the same target as the
// OSC-8 "Read the log" link in the orbit card), so a phone scan and a click
// land on the same place.
func TestLogQREncodesTheLogPageURL(t *testing.T) {
	url := logPageURL("4.b.12")
	if want := "https://www.fluncle.com/log/4.b.12"; url != want {
		t.Fatalf("logPageURL = %q, want %q", url, want)
	}

	beam := logQR(url)
	if beam == "" {
		t.Fatal("logQR returned empty for a real /log URL")
	}

	// Half-block mode draws from a fixed alphabet: the light field as block
	// glyphs and the dark data as spaces. Nothing else should appear once the
	// styling escapes are stripped.
	allowed := map[rune]bool{' ': true, '█': true, '▀': true, '▄': true, '\n': true}
	for _, r := range stripANSI(beam) {
		if !allowed[r] {
			t.Fatalf("unexpected glyph %q in QR render", r)
		}
	}

	// A QR is square: every painted row holds the same number of cells.
	lines := strings.Split(stripANSI(beam), "\n")
	if len(lines) < 8 {
		t.Fatalf("QR render too small: %d rows", len(lines))
	}
	width := len([]rune(lines[0]))
	for index, line := range lines {
		if got := len([]rune(line)); got != width {
			t.Fatalf("row %d width = %d, want %d (QR must be square)", index, got, width)
		}
	}
}

// Encoding is deterministic: the same URL always etches the same beam, so the
// orbit card renders stably frame to frame.
func TestLogQRIsDeterministic(t *testing.T) {
	url := logPageURL("9.z.01")
	if first, second := logQR(url), logQR(url); first != second {
		t.Fatal("logQR is not deterministic for the same URL")
	}
}

// The half-block glyphs and the space they replace must all share one display
// width, so the module grid stays aligned and the QR reads as a clean square no
// matter which glyph lands in a given cell.
func TestLogQRGlyphsShareOneWidth(t *testing.T) {
	beam := stripANSI(logQR(logPageURL("1.a.07")))
	if beam == "" {
		t.Fatal("logQR returned empty")
	}
	condition := runewidth.NewCondition()
	width := condition.StringWidth("█")
	for _, glyph := range []string{" ", "▀", "▄"} {
		if got := condition.StringWidth(glyph); got != width {
			t.Fatalf("QR glyph %q width = %d, want %d (all cells must align)", glyph, got, width)
		}
	}
}

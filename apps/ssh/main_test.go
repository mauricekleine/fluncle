package main

import (
	"testing"

	"github.com/mattn/go-runewidth"
)

func TestGalaxyPositionedGlyphsAreWidthOne(t *testing.T) {
	condition := runewidth.NewCondition()
	condition.EastAsianWidth = true

	for _, glyph := range []string{" ", ".", "+", "0", "E", "^", "o", "x"} {
		if width := condition.StringWidth(glyph); width != 1 {
			t.Fatalf("glyph %q width = %d under EastAsianWidth, want 1", glyph, width)
		}
	}
}

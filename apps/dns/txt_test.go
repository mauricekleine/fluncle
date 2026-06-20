package main

import (
	"strings"
	"testing"
)

func testCfg() config {
	return config{APIBase: "https://www.fluncle.com"}
}

func joined(strs []string) string {
	return strings.Join(strs, "")
}

func TestBuildTXT_FullFinding(t *testing.T) {
	tr := &track{
		LogID:      "011.1.6E",
		Artists:    []string{"Netsky"},
		Title:      "I See The Future In Your Eyes",
		Album:      "Second Nature",
		BPM:        171.09,
		Key:        "C minor",
		AddedAt:    "2026-06-10T14:17:41.737Z",
		LogPageURL: "https://www.fluncle.com/log/011.1.6E",
		SpotifyURL: "https://open.spotify.com/track/1rgIJkGSUqB3EgidQbEbxy",
	}
	got := joined(buildTXT(tr, testCfg()))
	want := "v=fluncle1; id=011.1.6E; artist=Netsky; title=I See The Future In Your Eyes; " +
		"album=Second Nature; bpm=171.09; key=C minor; found=2026-06-10; " +
		"url=https://www.fluncle.com/log/011.1.6E; spotify=https://open.spotify.com/track/1rgIJkGSUqB3EgidQbEbxy"
	if got != want {
		t.Fatalf("payload mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestBuildTXT_LeadsWithVersionAndID(t *testing.T) {
	tr := &track{LogID: "004.7.2I", Artists: []string{"A"}, Title: "T", AddedAt: "2026-06-03"}
	strs := buildTXT(tr, testCfg())
	if !strings.HasPrefix(strs[0], "v=fluncle1; id=004.7.2I; ") {
		t.Fatalf("expected version+id prefix, got %q", strs[0])
	}
}

func TestBuildTXT_MultipleArtistsJoined(t *testing.T) {
	tr := &track{LogID: "012.4.4D", Artists: []string{"Netsky", "Bev Lee Harling"}, Title: "X"}
	got := joined(buildTXT(tr, testCfg()))
	if !strings.Contains(got, "artist=Netsky, Bev Lee Harling;") {
		t.Fatalf("artists not joined: %q", got)
	}
}

func TestBuildTXT_DerivesURLWhenMissing(t *testing.T) {
	tr := &track{LogID: "012.4.4D", Artists: []string{"A"}, Title: "X"}
	got := joined(buildTXT(tr, testCfg()))
	if !strings.Contains(got, "url=https://www.fluncle.com/log/012.4.4D") {
		t.Fatalf("url not derived: %q", got)
	}
}

func TestBuildTXT_EscapesSeparatorInValue(t *testing.T) {
	tr := &track{LogID: "001.0.0A", Artists: []string{"A"}, Title: "Foo; Bar"}
	got := joined(buildTXT(tr, testCfg()))
	// The literal ';' inside the title must be downgraded so it cannot be
	// mistaken for the "; " field separator.
	if strings.Contains(got, "title=Foo; Bar") {
		t.Fatalf("separator inside value not escaped: %q", got)
	}
	if !strings.Contains(got, "title=Foo, Bar") {
		t.Fatalf("expected escaped title, got %q", got)
	}
}

func TestBuildTXT_EachStringWithinLimit(t *testing.T) {
	// A pathologically long album to force a multi-string split.
	tr := &track{
		LogID:   "001.0.0A",
		Artists: []string{"A"},
		Title:   "T",
		Album:   strings.Repeat("x", 400),
	}
	strs := buildTXT(tr, testCfg())
	if len(strs) < 2 {
		t.Fatalf("expected payload to split into multiple strings, got %d", len(strs))
	}
	for i, s := range strs {
		if len(s) > maxTXTString {
			t.Fatalf("string %d exceeds %d bytes: %d", i, maxTXTString, len(s))
		}
	}
	// Joined payload must reconstruct cleanly with the version still leading.
	if !strings.HasPrefix(joined(strs), "v=fluncle1; ") {
		t.Fatalf("joined payload lost its prefix")
	}
}

func TestFoundDate(t *testing.T) {
	if got := foundDate(&track{AddedAt: "2026-06-10T14:17:41.737Z"}); got != "2026-06-10" {
		t.Fatalf("addedAt: got %q", got)
	}
	if got := foundDate(&track{ReleaseDate: "2020-10-30"}); got != "2020-10-30" {
		t.Fatalf("releaseDate fallback: got %q", got)
	}
}

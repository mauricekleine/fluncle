package main

import (
	"strings"
	"testing"
)

// SSH command args resolve to the right opening deep link: the named screens, a
// bare Log ID coordinate (finding or F-marked mixtape), nothing, and junk.
func TestParseBootCommand(t *testing.T) {
	cases := []struct {
		name      string
		args      []string
		wantKind  bootKind
		wantCoord string
	}{
		{name: "no args is the menu", args: nil, wantKind: bootMenu},
		{name: "blank args is the menu", args: []string{"  "}, wantKind: bootMenu},
		{name: "latest", args: []string{"latest"}, wantKind: bootLatest},
		{name: "latest is case-insensitive", args: []string{"LATEST"}, wantKind: bootLatest},
		{name: "random", args: []string{"random"}, wantKind: bootRandom},
		{name: "finding coord", args: []string{"004.7.2I"}, wantKind: bootCoord, wantCoord: "004.7.2I"},
		{name: "mixtape coord", args: []string{"019.F.1A"}, wantKind: bootCoord, wantCoord: "019.F.1A"},
		{name: "unknown word", args: []string{"mixtapes"}, wantKind: bootUnknown},
		{name: "malformed coord", args: []string{"004.7"}, wantKind: bootUnknown},
		{name: "coord with bad char", args: []string{"004.7.2$"}, wantKind: bootUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseBootCommand(tc.args)
			if got.kind != tc.wantKind {
				t.Fatalf("kind = %v, want %v", got.kind, tc.wantKind)
			}
			if tc.wantCoord != "" && got.coord != tc.wantCoord {
				t.Fatalf("coord = %q, want %q", got.coord, tc.wantCoord)
			}
		})
	}
}

// looksLikeLogID is a DELIBERATELY LOOSE hand-typed pre-filter, not the canonical
// grammar (@fluncle/contracts/log-id `LOG_ID_TEST_VECTORS`). This test pins exactly
// what it accepts BEYOND that grammar — so the looseness is intentional and pinned,
// not an accident. It routes an SSH arg to the coordinate resolver, which does the
// authoritative lookup; anything malformed comes back "not found" from the server.
func TestLooksLikeLogID(t *testing.T) {
	// Canonical-valid coordinates (the contracts fixture's validFindings + validMixtapes
	// + validEditions): accepted, same as the strict grammar.
	canonical := []string{
		"004.7.2I", "241.7.3A", "018.8.9J", "1024.7.3I", // validFindings
		"019.F.1A", "019.F.1F", "1024.F.2C", // validMixtapes
		"023.L.1A", "030.L.1Z", "1024.L.9Z", // validEditions
	}
	for _, s := range canonical {
		if !looksLikeLogID(s) {
			t.Errorf("looksLikeLogID(%q) = false, want true (canonical coordinate)", s)
		}
	}

	// Accepted BEYOND the canonical grammar — the intended looseness. The strict TS
	// guards reject each of these, but the pre-filter lets them through to the resolver:
	//   - lowercase: a prompt-typed mark shouldn't have to be shifted; the resolver normalizes.
	//   - the contracts fixture's `malformed` set: every one is still three alphanumeric
	//     parts, so it reads as coordinate-shaped here — the resolver returns "not found".
	//   - `1.2.3`: any alphanumeric part length passes (no 3/4-digit sector rule here).
	looserAccept := []string{
		"241.7.3a", "019.f.1a", "023.l.1a", // lowercase
		"04.7.2I", "10240.7.3I", "019.G.1A", "019.F.1Z", "023.L.AA", "007.12.3I", "7.0.0Z", // fixture: malformed
		"1.2.3",
	}
	for _, s := range looserAccept {
		if !looksLikeLogID(s) {
			t.Errorf("looksLikeLogID(%q) = false, want true (accepted by the loose pre-filter)", s)
		}
	}

	// Genuinely NOT coordinate-shaped: the wrong part count, an empty part, a
	// non-alphanumeric char (a space, the `fluncle://` scheme's `:` and `/`, or `$`).
	notACoord := []string{
		"", "latest", "004.7", "004.7.2.1", "004..2I", "004.7.2 I",
		"fluncle://004.7.2I", "004.7.2$",
	}
	for _, s := range notACoord {
		if looksLikeLogID(s) {
			t.Errorf("looksLikeLogID(%q) = true, want false (not coordinate-shaped)", s)
		}
	}
}

// A boot deep link sets the opening screen and the loading flag so the terminal
// lands on the detail (not the menu) while the fetch is in flight.
func TestNewModelWithBootOpensDetail(t *testing.T) {
	for _, kind := range []bootKind{bootLatest, bootRandom, bootCoord} {
		m := newModelWithBoot(&app{}, 80, 24, bootCommand{kind: kind, coord: "004.7.2I"})
		if m.screen != screenDetail {
			t.Errorf("kind %v opened screen %q, want %q", kind, m.screen, screenDetail)
		}
		if !m.loading {
			t.Errorf("kind %v did not set loading", kind)
		}
	}

	menu := newModelWithBoot(&app{}, 80, 24, bootCommand{kind: bootMenu})
	if menu.screen != screenMenu {
		t.Errorf("menu boot opened %q, want %q", menu.screen, screenMenu)
	}

	unknown := newModelWithBoot(&app{}, 80, 24, bootCommand{kind: bootUnknown, raw: "wat"})
	if unknown.screen != screenMenu {
		t.Errorf("unknown boot opened %q, want the menu", unknown.screen)
	}
	if unknown.err == "" || !strings.Contains(unknown.err, "wat") {
		t.Errorf("unknown boot err = %q, want a line naming the bad command", unknown.err)
	}
	if strings.Contains(unknown.err, "!") {
		t.Errorf("unknown boot err = %q, contains an exclamation mark (VOICE.md)", unknown.err)
	}
}

// detailMsg and mixtapeDetailMsg fold a boot fetch into the right detail screen.
func TestBootDetailMessages(t *testing.T) {
	base := newModelWithBoot(&app{}, 80, 24, bootCommand{kind: bootCoord, coord: "004.7.2I"})

	updated, _ := base.Update(detailMsg{track: track{Title: "Aktive", LogID: "004.7.2I"}})
	m := updated.(model)
	if m.screen != screenDetail {
		t.Fatalf("detailMsg landed on %q, want %q", m.screen, screenDetail)
	}
	if m.loading {
		t.Error("detailMsg left loading set")
	}
	if m.current == nil || m.current.Title != "Aktive" {
		t.Error("detailMsg did not set the current finding")
	}

	updated, _ = base.Update(mixtapeDetailMsg{mixtape: mixtape{Title: "Dream 19", LogID: "019.F.1A"}})
	mm := updated.(model)
	if mm.screen != screenMixtapeDetail {
		t.Fatalf("mixtapeDetailMsg landed on %q, want %q", mm.screen, screenMixtapeDetail)
	}
	if mm.currentMixtape == nil || mm.currentMixtape.Title != "Dream 19" {
		t.Error("mixtapeDetailMsg did not set the current mixtape")
	}
}

// The non-interactive printed view drops the interactive help/keys line, since a
// one-shot page has no keyboard.
func TestStripHelpLine(t *testing.T) {
	body := scaffold("Finding", "", []string{rowTitleStyle.Render("Aktive")}, helpLine("q back", "ctrl+c quit"))
	stripped := stripHelpLine(body)
	if strings.Contains(stripped, "ctrl+c") {
		t.Error("stripHelpLine left the help keys in the printed view")
	}
	if !strings.Contains(stripped, "Aktive") {
		t.Error("stripHelpLine removed real content")
	}
}

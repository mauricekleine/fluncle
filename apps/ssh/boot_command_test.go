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

// looksLikeLogID accepts the XXX.Y.ZZ shape (alphanumerics, three parts) and the
// F-marked mixtape middle slot; it rejects everything else.
func TestLooksLikeLogID(t *testing.T) {
	good := []string{"004.7.2I", "019.F.1A", "241.7.3A", "1.2.3"}
	for _, s := range good {
		if !looksLikeLogID(s) {
			t.Errorf("looksLikeLogID(%q) = false, want true", s)
		}
	}
	bad := []string{"", "latest", "004.7", "004.7.2.1", "004..2I", "004.7.2 I", "fluncle://004.7.2I"}
	for _, s := range bad {
		if looksLikeLogID(s) {
			t.Errorf("looksLikeLogID(%q) = true, want false", s)
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

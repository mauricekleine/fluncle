// Unit tests for the tracklist-export formatters.
// Run: `bun src/util/tracklist-export.test.ts`

import assert from "node:assert/strict";

import {
  beatportSearchLinks,
  checklist,
  formatArtists,
  m3u8,
  type TrackInput,
} from "./tracklist-export";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const single: TrackInput[] = [{ artists: ["Shy FX"], title: "Original Nuttah" }];

const twoTrack: TrackInput[] = [
  { artists: ["Calyx", "TeeBee"], title: "Anatomy" },
  { artists: ["Noisia"], title: "Shellshock" },
];

// A blend track with special chars (accents, ampersand) to exercise URL-encoding.
const accentedBlend: TrackInput[] = [{ artists: ["Nü & Sōn"], title: "Réveillé" }];

// ── formatArtists ─────────────────────────────────────────────────────────────

{
  assert.equal(formatArtists(["Shy FX"]), "Shy FX");
  assert.equal(formatArtists(["Calyx", "TeeBee"]), "Calyx, TeeBee");
  assert.equal(formatArtists([]), "");
}

// ── beatportSearchLinks ───────────────────────────────────────────────────────

// Empty list returns empty array.
{
  assert.deepEqual(beatportSearchLinks([]), []);
}

// One URL per track, correct base URL, single artist encoded.
{
  const links = beatportSearchLinks(single);
  assert.equal(links.length, 1);
  assert.equal(links[0], "https://www.beatport.com/search?q=Shy%20FX%20Original%20Nuttah");
}

// Multi-artist joined (with ", ") before encoding; comma encoded as %2C.
{
  const [first, second] = beatportSearchLinks(twoTrack);
  assert.equal(first, "https://www.beatport.com/search?q=Calyx%2C%20TeeBee%20Anatomy");
  assert.ok(second?.startsWith("https://www.beatport.com/search?q="), "second URL has base");
}

// Accents and & are percent-encoded.
{
  const [url] = beatportSearchLinks(accentedBlend);
  const expected = `https://www.beatport.com/search?q=${encodeURIComponent("Nü & Sōn Réveillé")}`;
  assert.equal(url, expected);
}

// ── m3u8 ──────────────────────────────────────────────────────────────────────

// Empty list → only the #EXTM3U header (single line, no trailing newline).
{
  assert.equal(m3u8([]), "#EXTM3U");
}

// Always starts with #EXTM3U.
{
  const out = m3u8(single);
  assert.ok(out.startsWith("#EXTM3U\n"), `expected #EXTM3U header; got: ${out}`);
}

// One #EXTINF line per track with em-dash label (—).
{
  const out = m3u8(single);
  assert.ok(out.includes("#EXTINF:-1,Shy FX — Original Nuttah"), `missing extinf in:\n${out}`);
}

// Multi-artist uses ", " separator in the label.
{
  const out = m3u8(twoTrack);
  assert.ok(
    out.includes("#EXTINF:-1,Calyx, TeeBee — Anatomy"),
    `missing multi-artist extinf:\n${out}`,
  );
}

// Two tracks → two #EXTINF lines.
{
  const out = m3u8(twoTrack);
  const count = (out.match(/#EXTINF/g) ?? []).length;
  assert.equal(count, 2);
}

// Optional title emits #PLAYLIST after #EXTM3U.
{
  const out = m3u8(single, { title: "liquid-nebula-roller" });
  const lines = out.split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.equal(lines[1], "#PLAYLIST:liquid-nebula-roller");
}

// No opts → no #PLAYLIST line.
{
  const out = m3u8(single);
  assert.ok(!out.includes("#PLAYLIST"), "unexpected #PLAYLIST without opts.title");
}

// ── checklist ─────────────────────────────────────────────────────────────────

// Empty list returns empty string.
{
  assert.equal(checklist([]), "");
}

// Single track: "1. Artist — Title".
{
  assert.equal(checklist(single), "1. Shy FX — Original Nuttah");
}

// Two tracks numbered 1 and 2, one per line.
{
  const out = checklist(twoTrack);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.startsWith("1. "));
  assert.ok(lines[1]?.startsWith("2. "));
}

// Multi-artist track uses ", " separator in label.
{
  const out = checklist(twoTrack);
  assert.ok(out.includes("Calyx, TeeBee — Anatomy"), `missing multi-artist line:\n${out}`);
}

// Three tracks numbered 1–3 in order.
{
  const three: TrackInput[] = [...twoTrack, { artists: ["Logistics"], title: "Together" }];
  const lines = checklist(three).split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[2]?.startsWith("3. Logistics — Together"));
}

console.log("✓ tracklist-export: formatArtists, beatportSearchLinks, m3u8, checklist");

import assert from "node:assert/strict";

import {
  beatportSearchLinks,
  checklist,
  formatArtists,
  m3u8,
  type TrackInput,
} from "./tracklist-export";

const single: TrackInput[] = [{ artists: ["Shy FX"], title: "Original Nuttah" }];

const twoTrack: TrackInput[] = [
  { artists: ["Calyx", "TeeBee"], title: "Anatomy" },
  { artists: ["Noisia"], title: "Shellshock" },
];

const accentedBlend: TrackInput[] = [{ artists: ["Nü & Sōn"], title: "Réveillé" }];

{
  assert.equal(formatArtists(["Shy FX"]), "Shy FX");
  assert.equal(formatArtists(["Calyx", "TeeBee"]), "Calyx, TeeBee");
  assert.equal(formatArtists([]), "");
}

{
  assert.deepEqual(beatportSearchLinks([]), []);
}

{
  const links = beatportSearchLinks(single);
  assert.equal(links.length, 1);
  assert.equal(links[0], "https://www.beatport.com/search?q=Shy%20FX%20Original%20Nuttah");
}

{
  const [first, second] = beatportSearchLinks(twoTrack);
  assert.equal(first, "https://www.beatport.com/search?q=Calyx%2C%20TeeBee%20Anatomy");
  assert.ok(second?.startsWith("https://www.beatport.com/search?q="), "second URL has base");
}

{
  const [url] = beatportSearchLinks(accentedBlend);
  const expected = `https://www.beatport.com/search?q=${encodeURIComponent("Nü & Sōn Réveillé")}`;
  assert.equal(url, expected);
}

{
  assert.equal(m3u8([]), "#EXTM3U");
}

{
  const out = m3u8(single);
  assert.ok(out.startsWith("#EXTM3U\n"), `expected #EXTM3U header; got: ${out}`);
}

{
  const out = m3u8(single);
  assert.ok(out.includes("#EXTINF:-1,Shy FX — Original Nuttah"), `missing extinf in:\n${out}`);
}

{
  const out = m3u8(twoTrack);
  assert.ok(
    out.includes("#EXTINF:-1,Calyx, TeeBee — Anatomy"),
    `missing multi-artist extinf:\n${out}`,
  );
}

{
  const out = m3u8(twoTrack);
  const count = (out.match(/#EXTINF/g) ?? []).length;
  assert.equal(count, 2);
}

{
  const out = m3u8(single, { title: "liquid-nebula-roller" });
  const lines = out.split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.equal(lines[1], "#PLAYLIST:liquid-nebula-roller");
}

{
  const out = m3u8(single);
  assert.ok(!out.includes("#PLAYLIST"), "unexpected #PLAYLIST without opts.title");
}

{
  assert.equal(checklist([]), "");
}

{
  assert.equal(checklist(single), "1. Shy FX — Original Nuttah");
}

{
  const out = checklist(twoTrack);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.startsWith("1. "));
  assert.ok(lines[1]?.startsWith("2. "));
}

{
  const out = checklist(twoTrack);
  assert.ok(out.includes("Calyx, TeeBee — Anatomy"), `missing multi-artist line:\n${out}`);
}

{
  const three: TrackInput[] = [...twoTrack, { artists: ["Logistics"], title: "Together" }];
  const lines = checklist(three).split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[2]?.startsWith("3. Logistics — Together"));
}

console.log("✓ tracklist-export: formatArtists, beatportSearchLinks, m3u8, checklist");

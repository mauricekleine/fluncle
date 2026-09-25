import assert from "node:assert/strict";

import { parseContextNote } from "./context-note";

{
  const note = [
    "Orchestral Mix is a 2017 liquid drum-and-bass cut on a long-running label,",
    "known for layered, cinematic productions and intricate breakbeat programming.",
    "",
    "Texture: orchestrated, layered, expansive, foundational, intricate breakbeats, atmospheric depth.",
  ].join("\n");

  const parsed = parseContextNote(note);

  assert.equal(parsed.contextNote, note.trim(), "full note preserved");
  assert.deepEqual(
    parsed.texture,
    [
      "orchestrated",
      "layered",
      "expansive",
      "foundational",
      "intricate breakbeats",
      "atmospheric depth",
    ],
    "texture pointers parsed (trailing period stripped)",
  );
}

{
  const note = "Just facts, no texture line here.";
  const parsed = parseContextNote(note);

  assert.equal(parsed.contextNote, note, "note preserved");
  assert.deepEqual(parsed.texture, [], "no texture line → empty");
}

{
  const parsed = parseContextNote("   \n  ");

  assert.equal(parsed.contextNote, "", "blank note → empty string");
  assert.deepEqual(parsed.texture, [], "blank note → empty texture");
}

{
  const note = "A note.\n\ntexture:  rolling ,  nocturnal,  rolling , rain-on-glass  ";
  const parsed = parseContextNote(note);

  assert.deepEqual(
    parsed.texture,
    ["rolling", "nocturnal", "rain-on-glass"],
    "lowercase label, trimmed, de-duplicated case-insensitively",
  );
}

{
  const note = [
    "Texture: dense, grainy",
    "A bridge line mentioning texture: in passing.",
    "Texture: glassy, cold, metallic",
  ].join("\n");
  const parsed = parseContextNote(note);

  assert.deepEqual(parsed.texture, ["glassy", "cold", "metallic"], "last label line wins");
}

console.log("context-note: all assertions passed");

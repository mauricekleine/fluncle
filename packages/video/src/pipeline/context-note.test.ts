// Self-running check for the context-note Texture parser — no framework. The
// distilled note ends in one `Texture: ` line of comma-separated pointers; the
// parser splits those out as the most direct creative fuel while leaving the full
// note intact. A wrong split would feed the video agent the wrong direction.
// Run: `bun src/pipeline/context-note.test.ts`.

import assert from "node:assert/strict";

import { parseContextNote } from "./context-note";

// 1. A real-shaped note: prose paragraph + a trailing Texture line. The full note
//    is preserved untouched; the texture pointers are parsed, trimmed, de-duped.
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

// 2. No Texture line → full note kept, texture empty (graceful, not an error).
{
  const note = "Just facts, no texture line here.";
  const parsed = parseContextNote(note);

  assert.equal(parsed.contextNote, note, "note preserved");
  assert.deepEqual(parsed.texture, [], "no texture line → empty");
}

// 3. Blank / whitespace-only note → both empty (the caller drops it entirely).
{
  const parsed = parseContextNote("   \n  ");

  assert.equal(parsed.contextNote, "", "blank note → empty string");
  assert.deepEqual(parsed.texture, [], "blank note → empty texture");
}

// 4. Case-insensitive label, extra spacing, and a stray duplicate pointer.
{
  const note = "A note.\n\ntexture:  rolling ,  nocturnal,  rolling , rain-on-glass  ";
  const parsed = parseContextNote(note);

  assert.deepEqual(
    parsed.texture,
    ["rolling", "nocturnal", "rain-on-glass"],
    "lowercase label, trimmed, de-duplicated case-insensitively",
  );
}

// 5. Only a line that STARTS with the label counts; an inline "texture:" mid-prose
//    is ignored, and when two label lines exist the LAST one wins.
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

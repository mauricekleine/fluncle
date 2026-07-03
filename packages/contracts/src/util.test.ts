// Self-running checks for `resolveClipTracks` — no framework (the galaxy-slug.test.ts
// precedent). Run: `bun src/util.test.ts` (or `bun test`).
//
// The RFC plan→recording→mixtape §5 addition under test: a member's `logId` is carried
// THROUGH the resolver to each covered `ResolvedClipTrack`, so `buildClipCaption` can
// emit the covered finding's `fluncle://<logId>` line. Overlap/blend/clamp semantics are
// unchanged; this pins the new carry-through + confirms un-cued members still yield `[]`.

import assert from "node:assert/strict";

import { resolveClipTracks } from "./util";

// A window inside one cue's interval resolves to that single member, carrying its logId.
{
  const resolved = resolveClipTracks({
    inMs: 30_000,
    members: [
      { artists: ["A"], logId: "019.F.1A", startMs: 0, title: "One" },
      { artists: ["B"], logId: "019.F.1B", startMs: 120_000, title: "Two" },
    ],
    outMs: 50_000,
    setDurationMs: 600_000,
  });

  assert.equal(resolved.length, 1, "single-cue window resolves to one member");
  assert.equal(resolved[0]?.logId, "019.F.1A", "the member's logId is carried through");
}

// A window straddling a cue boundary resolves to BOTH members (a blend), in play order,
// each carrying its own logId.
{
  const resolved = resolveClipTracks({
    inMs: 100_000,
    members: [
      { artists: ["A"], logId: "019.F.1A", startMs: 0, title: "One" },
      { artists: ["B"], logId: "019.F.1B", startMs: 120_000, title: "Two" },
    ],
    outMs: 140_000,
    setDurationMs: 600_000,
  });

  assert.deepEqual(
    resolved.map((track) => track.logId),
    ["019.F.1A", "019.F.1B"],
    "a blend carries both logIds in play order",
  );
}

// A member with no logId (a played-but-not-a-finding cue) resolves with `logId`
// undefined — the caller drops it (honest silence, no misattribution).
{
  const resolved = resolveClipTracks({
    inMs: 10_000,
    members: [{ artists: ["White Label"], startMs: 0, title: "Dubplate" }],
    outMs: 20_000,
    setDurationMs: 600_000,
  });

  assert.equal(resolved.length, 1, "the overlapping non-finding cue still resolves");
  assert.equal(resolved[0]?.logId, undefined, "a non-finding cue carries no logId");
}

// An UN-CUED set (no startMs) still resolves to `[]` (the caller falls back).
{
  const resolved = resolveClipTracks({
    inMs: 0,
    members: [{ artists: ["A"], logId: "019.F.1A", title: "One" }],
    outMs: 60_000,
    setDurationMs: 600_000,
  });

  assert.equal(resolved.length, 0, "an un-cued set resolves to []");
}

console.log("resolveClipTracks logId carry-through: OK");

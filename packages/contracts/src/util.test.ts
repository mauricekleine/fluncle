// Self-running checks for `resolveClipTracks` — no framework (the galaxy-slug.test.ts
// precedent). Run: `bun src/util.test.ts` (or `bun test`).
//
// The RFC plan→recording→mixtape §5 addition under test: a member's `logId` is carried
// THROUGH the resolver to each covered `ResolvedClipTrack`, so `buildClipCaption` can
// emit the covered finding's `fluncle://<logId>` line. Overlap/blend/clamp semantics are
// unchanged; this pins the new carry-through + confirms un-cued members still yield `[]`.

import assert from "node:assert/strict";

import {
  isStaleTikTokDraft,
  resolveClipTracks,
  TIKTOK_DRAFT_STALE_MS,
  tikTokDraftAgeHours,
} from "./util";

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

// ── TikTok stale-draft rule (clock-injected) ─────────────────────────────────
// TikTok bounces the 6th+ pending inbox draft asynchronously; a `draft` row older
// than 24h off `updatedAt` has almost certainly bounced and must read as UNPOSTED.
{
  const NOW = Date.parse("2026-07-06T20:00:00.000Z");
  const fresh = { platform: "tiktok", status: "draft", updatedAt: "2026-07-06T12:00:00.000Z" };
  const stale = { platform: "tiktok", status: "draft", updatedAt: "2026-07-05T10:00:00.000Z" };

  // A fresh draft (8h old) is still trusted as in the inbox.
  assert.equal(isStaleTikTokDraft(fresh, NOW), false, "a fresh TikTok draft is not stale");
  assert.equal(tikTokDraftAgeHours(fresh, NOW), 8, "a fresh draft reports its age in hours");

  // A stale draft (>24h) reads as bounced.
  assert.equal(isStaleTikTokDraft(stale, NOW), true, "a >24h TikTok draft is stale");
  assert.equal(tikTokDraftAgeHours(stale, NOW), 34, "a stale draft reports its age in hours");

  // The boundary: exactly 24h is stale; a second short of it is not.
  const at24h = {
    platform: "tiktok",
    status: "draft",
    updatedAt: new Date(NOW - TIKTOK_DRAFT_STALE_MS).toISOString(),
  };
  const under24h = {
    platform: "tiktok",
    status: "draft",
    updatedAt: new Date(NOW - TIKTOK_DRAFT_STALE_MS + 1000).toISOString(),
  };
  assert.equal(isStaleTikTokDraft(at24h, NOW), true, "exactly 24h old is stale");
  assert.equal(isStaleTikTokDraft(under24h, NOW), false, "a second under 24h is fresh");

  // Only a tiktok draft can be stale; every other row is exempt.
  const oldPublished = {
    platform: "tiktok",
    status: "published",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const oldYoutubeDraft = {
    platform: "youtube",
    status: "draft",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(
    isStaleTikTokDraft(oldPublished, NOW),
    false,
    "a published TikTok post is never stale",
  );
  assert.equal(isStaleTikTokDraft(oldYoutubeDraft, NOW), false, "a YouTube draft is never stale");
  assert.equal(tikTokDraftAgeHours(oldPublished, NOW), null, "age is null for a non-draft");

  // Conservative on bad data: no stamp / unparseable → NOT stale (no false re-push).
  assert.equal(
    isStaleTikTokDraft({ platform: "tiktok", status: "draft" }, NOW),
    false,
    "a draft with no updatedAt is not stale",
  );
  assert.equal(
    isStaleTikTokDraft({ platform: "tiktok", status: "draft", updatedAt: "not-a-date" }, NOW),
    false,
    "a draft with an unparseable updatedAt is not stale",
  );
}

console.log("isStaleTikTokDraft / tikTokDraftAgeHours: OK");

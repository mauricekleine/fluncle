import assert from "node:assert/strict";

import {
  isStaleTikTokDraft,
  r2PublicUrl,
  resolveClipTracks,
  TIKTOK_DRAFT_STALE_MS,
  tikTokDraftAgeHours,
} from "./util";

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

{
  const NOW = Date.parse("2026-07-06T20:00:00.000Z");
  const fresh = { platform: "tiktok", status: "draft", updatedAt: "2026-07-06T12:00:00.000Z" };
  const stale = { platform: "tiktok", status: "draft", updatedAt: "2026-07-05T10:00:00.000Z" };

  assert.equal(isStaleTikTokDraft(fresh, NOW), false, "a fresh TikTok draft is not stale");
  assert.equal(tikTokDraftAgeHours(fresh, NOW), 8, "a fresh draft reports its age in hours");

  assert.equal(isStaleTikTokDraft(stale, NOW), true, "a >24h TikTok draft is stale");
  assert.equal(tikTokDraftAgeHours(stale, NOW), 34, "a stale draft reports its age in hours");

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

{
  const base = "https://found.fluncle.com";

  assert.equal(
    r2PublicUrl(base, "recordings/1e0b3f/set.mp4"),
    "https://found.fluncle.com/recordings/1e0b3f/set.mp4",
    "an un-promoted recording key passes through unchanged",
  );
  assert.equal(
    r2PublicUrl(base, "241.7.3A/set.mp4"),
    "https://found.fluncle.com/241.7.3A/set.mp4",
    "a promoted dot-safe Log ID key passes through unchanged",
  );

  assert.equal(
    r2PublicUrl(base, "a b/c#d/set.mp4"),
    "https://found.fluncle.com/a%20b/c%23d/set.mp4",
    "reserved characters inside a segment are percent-encoded, slashes preserved",
  );
}

console.log("r2PublicUrl: OK");

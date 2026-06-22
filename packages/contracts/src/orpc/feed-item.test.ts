// Self-running check for the FeedItem union ordering — no framework. Load-bearing
// invariant: the TrackListItem (finding) arm MUST stay first in the union so a
// finding whose optional `type` is ABSENT still parses as a finding, while
// `type: "mixtape"` takes the mixtape arm. Reorder the union and a typeless
// finding silently mis-parses. Run: `bun src/orpc/feed-item.test.ts`.

import assert from "node:assert/strict";

import { FeedItemSchema } from "./_shared";

// A minimal valid finding (TrackListItem) — note: NO `type` field.
const finding = {
  addedAt: "2026-06-08T12:00:00Z",
  addedToSpotify: true,
  artists: ["Artist One"],
  durationMs: 210_000,
  enrichmentStatus: "done",
  postedToTelegram: false,
  spotifyUrl: "https://open.spotify.com/track/abc",
  title: "The Title",
  trackId: "abc",
};

// 1. A finding WITHOUT `type` parses, and lands on the finding arm (it has a
//    `trackId`, which the mixtape arm does not).
{
  const parsed = FeedItemSchema.parse(finding);
  assert.ok("trackId" in parsed, "a typeless finding must parse as the finding arm");
  assert.equal((parsed as { trackId: string }).trackId, "abc");
}

// 2. A finding WITH explicit `type: "finding"` still parses as the finding arm.
{
  const parsed = FeedItemSchema.parse({ ...finding, type: "finding" });
  assert.equal((parsed as { type?: string }).type, "finding");
  assert.ok("trackId" in parsed, "explicit-finding stays on the finding arm");
}

// 3. A mixtape (`type: "mixtape"`) parses as the mixtape arm.
{
  const mixtape = {
    artists: ["Fluncle"] as const,
    externalUrls: {},
    memberCount: 0,
    members: [],
    status: "published" as const,
    title: "Mixtape One",
    type: "mixtape" as const,
  };
  const parsed = FeedItemSchema.parse(mixtape);
  assert.equal((parsed as { type?: string }).type, "mixtape", "type:'mixtape' → mixtape arm");
  assert.ok(!("trackId" in parsed), "the mixtape arm has no trackId");
}

console.log(
  "✓ feed-item union: typeless finding → finding arm, explicit finding holds, mixtape → mixtape arm",
);

import assert from "node:assert/strict";

import { FeedItemSchema } from "./_shared";

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

{
  const parsed = FeedItemSchema.parse(finding);
  assert.ok("trackId" in parsed, "a typeless finding must parse as the finding arm");
  assert.equal((parsed as { trackId: string }).trackId, "abc");
}

{
  const parsed = FeedItemSchema.parse({ ...finding, type: "finding" });
  assert.equal((parsed as { type?: string }).type, "finding");
  assert.ok("trackId" in parsed, "explicit-finding stays on the finding arm");
}

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

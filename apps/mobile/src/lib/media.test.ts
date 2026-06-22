// Self-running checks for resolveCardMedia — no framework, mirroring the repo's
// node:assert test style (packages/contracts/src/orpc/feed-item.test.ts). Run via
// `bun test` (reports "0 pass" — there are no describe/it blocks — but throws and
// fails the process on any failed assertion) or `bun src/lib/media.test.ts`.
//
// resolveCardMedia is the drift-prone mobile twin of apps/web/src/lib/media.ts
// (the file's own header says "keep in step with"). These pin the per-card media
// ladder so the rungs (clean square master → video, else → cover) and the known
// legacy data quirk can't silently regress on this surface. The MT URL shapes
// mirror the web media.test.ts assertions where they overlap.

import { type TrackListItem } from "@fluncle/contracts";

import { API_BASE, FOUND_BASE } from "@/config";
import { resolveCardMedia } from "@/lib/media";

// A tiny strict-equality assertion. The mobile package is an Expo (no-node) tsconfig
// without `@types/node`, so `node:assert` doesn't typecheck here; this keeps the
// test framework-free and dependency-free while still throwing (and failing the
// `bun test` process) on a mismatch.
function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// A minimal finding on the "finding" arm of TrackListItem with the fields the
// media ladder reads; the rest is filled to satisfy the type.
function finding(overrides: Partial<TrackListItem>): TrackListItem {
  return {
    addedAt: "2026-06-21T10:00:00.000Z",
    addedToSpotify: true,
    artists: ["Tester"],
    durationMs: 200_000,
    enrichmentStatus: "done",
    postedToTelegram: false,
    spotifyUrl: "https://open.spotify.com/track/abc",
    title: "A Banger",
    trackId: "TRACK123",
    ...overrides,
  };
}

// 1. A finding with a logId + a squared master takes the VIDEO rung.
{
  const media = resolveCardMedia(
    finding({ logId: "LOG123", videoSquaredAt: "2026-06-21T10:00:00.000Z" }),
  );

  assertEqual(media.kind, "video", "logId + videoSquaredAt → video rung");

  if (media.kind === "video") {
    // The feed plays the RAW square master (iOS AVPlayer needs HTTP Range, which
    // the MT crop does not honor), cropped to portrait by the player.
    assertEqual(media.videoUrl, `${FOUND_BASE}/LOG123/footage.mp4`, "video plays the raw master");
    // A cheap edge-cached opening frame for first paint.
    assertEqual(
      media.posterUrl,
      `${FOUND_BASE}/cdn-cgi/media/mode=frame,time=0s,format=jpg/${FOUND_BASE}/LOG123/footage.mp4`,
      "poster is the same-zone mode=frame transform",
    );
    assertEqual(media.hasAudio, true, "the video rung carries audio");
    // The raw master is the onError fallback target, never an MT transform.
    assertEqual(
      media.videoUrl.includes("/cdn-cgi/media"),
      false,
      "the master is raw, not an MT transform",
    );
  }
}

// 2. A LEGACY finding (videoUrl set, videoSquaredAt ABSENT) takes the COVER rung,
//    NOT a portrait video, so the native overlay never double-prints over the
//    baked text. This is the known data quirk this whole module guards.
{
  const media = resolveCardMedia(
    finding({
      albumImageUrl: "https://i.scdn.co/image/cover",
      logId: "LOG123",
      previewUrl: "https://p.scdn.co/preview",
      videoUrl: `${FOUND_BASE}/LOG123/footage.mp4`,
    }),
  );

  assertEqual(media.kind, "cover", "legacy videoUrl without videoSquaredAt → cover, not video");
}

// 3. The video rung requires BOTH a logId and videoSquaredAt; a missing logId
//    falls through to the cover rung even when squared.
{
  const media = resolveCardMedia(finding({ videoSquaredAt: "2026-06-21T10:00:00.000Z" }));

  assertEqual(media.kind, "cover", "no logId → cover rung even when squared");
}

// 4. A cover finding WITH a previewUrl gets the preview proxy, keyed by logId.
{
  const media = resolveCardMedia(
    finding({
      albumImageUrl: "https://i.scdn.co/image/cover",
      logId: "LOG123",
      previewUrl: "https://p.scdn.co/preview",
    }),
  );

  assertEqual(media.kind, "cover", "no squared master → cover rung");

  if (media.kind === "cover") {
    assertEqual(media.coverUrl, "https://i.scdn.co/image/cover", "cover carries the album image");
    // The proxy is the live relay (expiring previewUrl tokens aren't used
    // directly); keyed by the logId when present.
    assertEqual(
      media.previewUrl,
      `${API_BASE}/api/v1/preview/LOG123`,
      "preview proxy is keyed by logId",
    );
  }
}

// 5. With no logId, the preview proxy is keyed by trackId instead.
{
  const media = resolveCardMedia(
    finding({
      albumImageUrl: "https://i.scdn.co/image/cover",
      previewUrl: "https://p.scdn.co/preview",
    }),
  );

  assertEqual(media.kind, "cover");

  if (media.kind === "cover") {
    assertEqual(
      media.previewUrl,
      `${API_BASE}/api/v1/preview/TRACK123`,
      "preview proxy falls back to trackId",
    );
  }
}

// 6. A cover finding with NO previewUrl gets an undefined preview (silent cover).
{
  const media = resolveCardMedia(
    finding({ albumImageUrl: "https://i.scdn.co/image/cover", logId: "LOG123" }),
  );

  assertEqual(media.kind, "cover");

  if (media.kind === "cover") {
    assertEqual(media.previewUrl, undefined, "no previewUrl → silent cover (undefined preview)");
    assertEqual(media.coverUrl, "https://i.scdn.co/image/cover");
  }
}

// 7. A missing cover passes through as undefined.
{
  const media = resolveCardMedia(finding({ trackId: "TRACK123" }));

  assertEqual(media.kind, "cover");

  if (media.kind === "cover") {
    assertEqual(media.coverUrl, undefined, "absent albumImageUrl → undefined coverUrl");
  }
}

console.log(
  "✓ resolveCardMedia: squared → video (raw master), legacy → cover, preview proxy keyed by logId∕trackId or undefined",
);

// Self-running checks for resolveCardMedia — no framework, mirroring the repo's
// node:assert test style (packages/contracts/src/orpc/feed-item.test.ts). Run via
// `bun test` (reports "0 pass" — there are no describe/it blocks — but throws and
// fails the process on any failed assertion) or `bun src/lib/media.test.ts`.
//
// resolveCardMedia is the drift-prone mobile twin of apps/web/src/lib/media.ts
// (the file's own header says "keep in step with"). These pin the per-card media
// ladder so the rungs (clean square master → muted video + preview bed, else → cover)
// and the known legacy data quirk can't silently regress on this surface, and the
// App-Store 5.2.3 `hasAudio: false` muted-visual invariant is pinned. The MT URL shapes
// mirror the web media.test.ts assertions where they overlap.

import { type TrackListItem } from "@fluncle/contracts";

import { API_BASE, FOUND_BASE } from "@/config";
import { hasRender, resolveCardMedia } from "@/lib/media";

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

// 1. A finding with a logId + a squared master takes the VIDEO rung — a MUTED VISUAL
//    whose audio is the official preview bed (App Store 5.2.3; the video NEVER sounds
//    its own baked track).
{
  const media = resolveCardMedia(
    finding({
      logId: "LOG123",
      previewUrl: "https://p.scdn.co/preview",
      videoSquaredAt: "2026-06-21T10:00:00.000Z",
    }),
  );

  assertEqual(media.kind, "video", "logId + videoSquaredAt → video rung");

  if (media.kind === "video") {
    // The feed plays the RAW square master (iOS AVPlayer needs HTTP Range, which
    // the MT crop does not honor), cropped to portrait by the player.
    assertEqual(media.videoUrl, `${FOUND_BASE}/LOG123/footage.mp4`, "video plays the raw master");
    // A cheap edge-cached opening frame for first paint, versioned by the video
    // VINTAGE (?v=<videoSquaredAt epoch>) so a re-render mints a fresh MT URL —
    // MT's internal output cache is keyed on the URL and not purgeable (web media.ts).
    assertEqual(
      media.posterUrl,
      `${FOUND_BASE}/cdn-cgi/media/mode=frame,time=0s,format=jpg/${FOUND_BASE}/LOG123/footage.mp4?v=${Date.parse("2026-06-21T10:00:00.000Z")}`,
      "poster is the same-zone mode=frame transform, vintage-versioned",
    );
    // THE 5.2.3 INVARIANT: the video is a muted visual — `hasAudio` is the literal
    // `false`, so any regression that tries to sound the baked commercial track fails to
    // typecheck. The card's audio is the preview bed, the same path a cover uses, keyed
    // by logId.
    assertEqual(media.hasAudio, false, "the video rung is a muted visual (never its own track)");
    assertEqual(
      media.previewUrl,
      `${API_BASE}/api/v1/preview/LOG123`,
      "the video's audio bed is the preview proxy, keyed by logId",
    );
    // The raw master is the onError fallback target, never an MT transform.
    assertEqual(
      media.videoUrl.includes("/cdn-cgi/media"),
      false,
      "the master is raw, not an MT transform",
    );
    // The feed plays the CLEAN square master ONLY — never `footage.social.mp4`, the
    // baked-text cut (else the native overlay double-prints). "Never social" is a
    // compile-time guarantee (the builder hard-codes footage.mp4); this pins it so a
    // future social fallback can't slip onto this surface unnoticed.
    assertEqual(media.videoUrl.includes("social"), false, "the feed never plays the social cut");
    assertEqual(media.posterUrl.includes("social"), false, "the poster is off the clean master");
  }
}

// 1b. A squared-master finding with NO stored previewUrl STILL gets the bed: the proxy is a
//     re-resolving waterfall (ISRC/iTunes rungs) that sounds the finding whether or not the
//     ephemeral stored token is present, so the app gates on the finding's identity (title +
//     artist), not the stored URL. The video stays a muted visual either way (5.2.3).
{
  const media = resolveCardMedia(
    finding({ logId: "LOG123", videoSquaredAt: "2026-06-21T10:00:00.000Z" }),
  );

  assertEqual(media.kind, "video", "squared master → video rung even without a stored preview");

  if (media.kind === "video") {
    assertEqual(media.hasAudio, false, "still a muted visual (never its own track)");
    assertEqual(
      media.previewUrl,
      `${API_BASE}/api/v1/preview/LOG123`,
      "no stored previewUrl still gets the proxy bed — the waterfall re-resolves it",
    );
  }
}

// 1c. THE genuine-miss floor: a finding with no title/artist to fuzzy-resolve by has no bed
//     (a true silent visual). This is the only shape the proxy cannot sound.
{
  const media = resolveCardMedia(
    finding({
      artists: [],
      logId: "LOG123",
      title: "",
      videoSquaredAt: "2026-06-21T10:00:00.000Z",
    }),
  );

  if (media.kind === "video") {
    assertEqual(media.previewUrl, undefined, "no resolvable metadata → no bed (silent visual)");
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

// 6. A cover finding with NO stored previewUrl STILL gets the proxy bed — the waterfall
//    re-resolves a catalogue/cover row's clip the same as a finding's (the Ear audition).
{
  const media = resolveCardMedia(
    finding({ albumImageUrl: "https://i.scdn.co/image/cover", logId: "LOG123" }),
  );

  assertEqual(media.kind, "cover");

  if (media.kind === "cover") {
    assertEqual(
      media.previewUrl,
      `${API_BASE}/api/v1/preview/LOG123`,
      "no stored previewUrl still gets the proxy bed",
    );
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

// 8. `hasRender` is EXACTLY the video-rung predicate, and it agrees with
//    `resolveCardMedia().kind === "video"` on every shape. This is the guard the Feed
//    filters on (app/(tabs)/index.tsx), so it must never diverge from the ladder.
{
  const rendered = finding({ logId: "LOG123", videoSquaredAt: "2026-06-21T10:00:00.000Z" });
  const legacy = finding({ logId: "LOG123", videoUrl: `${FOUND_BASE}/LOG123/footage.mp4` });
  const squaredNoLog = finding({ videoSquaredAt: "2026-06-21T10:00:00.000Z" });
  const bare = finding({ albumImageUrl: "https://i.scdn.co/image/cover" });

  assertEqual(hasRender(rendered), true, "logId + videoSquaredAt → hasRender");
  assertEqual(hasRender(legacy), false, "legacy videoUrl without squared master → not rendered");
  assertEqual(hasRender(squaredNoLog), false, "no logId → not rendered even when squared");
  assertEqual(hasRender(bare), false, "no render fields → not rendered");

  // hasRender ⇔ the video rung, on each shape.
  for (const f of [rendered, legacy, squaredNoLog, bare]) {
    assertEqual(
      hasRender(f),
      resolveCardMedia(f).kind === "video",
      "hasRender agrees with the video rung",
    );
  }
}

// 9. THE FEED FILTER (operator ruling): filtering a mixed batch by `hasRender` — exactly
//    what app/(tabs)/index.tsx does over the flattened feed — keeps only the first-party
//    renders and drops every cover-placeholder (un-rendered) finding.
{
  const rendered = finding({ logId: "LOGA", videoSquaredAt: "2026-06-21T10:00:00.000Z" });
  const alsoRendered = finding({
    logId: "LOGB",
    trackId: "TRACKB",
    videoSquaredAt: "2026-06-22T10:00:00.000Z",
  });
  const coverOnly = finding({
    albumImageUrl: "https://i.scdn.co/image/cover",
    logId: "LOGC",
    trackId: "TRACKC",
  });
  const legacyCover = finding({
    logId: "LOGD",
    trackId: "TRACKD",
    videoUrl: `${FOUND_BASE}/LOGD/footage.mp4`,
  });

  const feed = [rendered, coverOnly, alsoRendered, legacyCover].filter(hasRender);

  assertEqual(feed.length, 2, "only the two rendered findings survive the Feed filter");
  assertEqual(feed[0]?.logId, "LOGA", "first survivor is the first render, order preserved");
  assertEqual(feed[1]?.logId, "LOGB", "second survivor is the second render");
  assertEqual(
    feed.every((f) => resolveCardMedia(f).kind === "video"),
    true,
    "every Feed card is a first-party video, never a cover placeholder",
  );
}

console.log(
  "✓ resolveCardMedia: squared → muted video (raw master) + preview bed, legacy → cover, preview proxy keyed by logId∕trackId or undefined; hasRender gates the Feed to first-party renders",
);

import { type TrackListItem } from "@fluncle/contracts";

import { API_BASE, FOUND_BASE } from "@/config";
import { hasRender, resolveCardMedia } from "@/lib/media";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

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
    assertEqual(media.videoUrl, `${FOUND_BASE}/LOG123/footage.mp4`, "video plays the raw master");

    assertEqual(
      media.posterUrl,
      `${FOUND_BASE}/cdn-cgi/media/mode=frame,time=0s,format=jpg/${FOUND_BASE}/LOG123/footage.mp4?v=${Date.parse("2026-06-21T10:00:00.000Z")}`,
      "poster is the same-zone mode=frame transform, vintage-versioned",
    );

    assertEqual(media.hasAudio, false, "the video rung is a muted visual (never its own track)");
    assertEqual(
      media.previewUrl,
      `${API_BASE}/api/v1/preview/LOG123`,
      "the video's audio bed is the preview proxy, keyed by logId",
    );

    assertEqual(
      media.videoUrl.includes("/cdn-cgi/media"),
      false,
      "the master is raw, not an MT transform",
    );

    assertEqual(media.videoUrl.includes("social"), false, "the feed never plays the social cut");
    assertEqual(media.posterUrl.includes("social"), false, "the poster is off the clean master");
  }
}

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

{
  const media = resolveCardMedia(finding({ videoSquaredAt: "2026-06-21T10:00:00.000Z" }));

  assertEqual(media.kind, "cover", "no logId → cover rung even when squared");
}

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

    assertEqual(
      media.previewUrl,
      `${API_BASE}/api/v1/preview/LOG123`,
      "preview proxy is keyed by logId",
    );
  }
}

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

{
  const media = resolveCardMedia(finding({ trackId: "TRACK123" }));

  assertEqual(media.kind, "cover");

  if (media.kind === "cover") {
    assertEqual(media.coverUrl, undefined, "absent albumImageUrl → undefined coverUrl");
  }
}

{
  const rendered = finding({ logId: "LOG123", videoSquaredAt: "2026-06-21T10:00:00.000Z" });
  const legacy = finding({ logId: "LOG123", videoUrl: `${FOUND_BASE}/LOG123/footage.mp4` });
  const squaredNoLog = finding({ videoSquaredAt: "2026-06-21T10:00:00.000Z" });
  const bare = finding({ albumImageUrl: "https://i.scdn.co/image/cover" });

  assertEqual(hasRender(rendered), true, "logId + videoSquaredAt → hasRender");
  assertEqual(hasRender(legacy), false, "legacy videoUrl without squared master → not rendered");
  assertEqual(hasRender(squaredNoLog), false, "no logId → not rendered even when squared");
  assertEqual(hasRender(bare), false, "no render fields → not rendered");

  for (const f of [rendered, legacy, squaredNoLog, bare]) {
    assertEqual(
      hasRender(f),
      resolveCardMedia(f).kind === "video",
      "hasRender agrees with the video rung",
    );
  }
}

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

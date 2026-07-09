// Bluesky (AT Protocol) publish side-channel. When a finding publishes, the
// publish boundary posts it to @fluncle.bsky.social as a link card pointing at
// the finding's /log page, with the finding's OG card as the card thumbnail.
//
// This mirrors telegram.ts — a single non-platform HTTPS caller kept in
// `apps/web`, so the Worker stays the one place that talks to a delivery service
// (the AT Protocol app password lives in Worker secrets, never on the agent box).
// Plain `fetch` against the XRPC endpoints — no @atproto/api dependency.
//
// The whole feature is a NO-OP until `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD`
// are set: `readOptionalEnv` returns undefined, `postToBluesky` returns
// immediately, and a publish is never touched. SAFETY: the publish call site
// swallows any error this throws (same discipline as the Deezer / Last.fm /
// artist-upsert side channels), so a Bluesky hiccup can never fail or delay a
// finding going out — nor the Telegram leg that runs before it.

import { logPageUrl, siteUrl } from "../fluncle-links";
import { readOptionalEnv } from "./env";
import { type TrackMetadata } from "./spotify";

// bsky.social hosts the @fluncle.bsky.social handle, so its PDS is the XRPC host
// for the session + the repo writes.
const XRPC_BASE = "https://bsky.social/xrpc";

// The default card description when the operator hasn't authored a finding note —
// the entity tagline (docs/socials/), so the link preview never reads empty.
const DEFAULT_CARD_DESCRIPTION = "Drum & bass bangers from another dimension.";

const notePrefix = "Why I'm playing it:";

// A richtext facet marking a byte range of the post text as a link (AT Protocol
// works in UTF-8 byte offsets, not JS string indices).
type Facet = {
  index: { byteEnd: number; byteStart: number };
  features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string }>;
};

// The external link-card embed (app.bsky.embed.external) with its optional thumb
// blob, resolved from uploadBlob.
type ExternalEmbed = {
  $type: "app.bsky.embed.external";
  external: {
    description: string;
    thumb?: BlobRef;
    title: string;
    uri: string;
  };
};

// The blob reference uploadBlob returns; passed straight back into the record.
type BlobRef = {
  $type: "blob";
  mimeType: string;
  ref: { $link: string };
  size: number;
};

type CreateSessionResponse = { accessJwt: string; did: string };

// The pure shape of a finding's Bluesky post: the text (mirroring the Telegram
// register — the 🛸 header, the artist line, the note, the 🎧 Spotify listen
// link), the facet that turns the inlined Spotify URL into a tappable link, and
// the external-card fields (the /log page + its OG card thumb). Exported +
// transport-free so the text/facet builders can be unit-tested without the API.
export function formatBlueskyPost(
  track: TrackMetadata,
  note?: string,
  logId?: string,
): {
  external: { description: string; title: string; uri: string };
  facets: Facet[];
  text: string;
} {
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;
  const lines = [`🛸 Fluncle's Findings`, "", artistLine];

  const trimmedNote = note?.trim();

  if (trimmedNote) {
    lines.push(`${notePrefix} ${trimmedNote}`);
  }

  // The listen link, inlined like the Telegram post's Spotify line. The card
  // below carries the /log home, so the text carries the direct Spotify link (a
  // different URL) — one link per surface, no hashtag spam.
  const spotifyLine = `🎧 Spotify: ${track.spotifyUrl}`;
  lines.push("", spotifyLine);

  const text = lines.join("\n");
  const facets = [linkFacet(text, track.spotifyUrl)].filter((facet): facet is Facet =>
    Boolean(facet),
  );

  // The card points at the finding's permanent home. Older findings predate the
  // Log ID; fall back to the site root so the embed still resolves.
  const uri = logId?.trim() ? logPageUrl(logId) : `${siteUrl}/`;

  return {
    external: {
      description: trimmedNote && trimmedNote.length > 0 ? trimmedNote : DEFAULT_CARD_DESCRIPTION,
      title: artistLine,
      uri,
    },
    facets,
    text,
  };
}

// Build a link facet for the first occurrence of `url` in `text`, in UTF-8 byte
// offsets (AT Protocol indexes richtext by bytes, so a multi-byte glyph like 🛸
// before the URL shifts the range). Returns undefined when the URL isn't found.
// Exported for the unit test.
export function linkFacet(text: string, url: string): Facet | undefined {
  const charIndex = text.indexOf(url);

  if (charIndex === -1) {
    return undefined;
  }

  const encoder = new TextEncoder();
  const byteStart = encoder.encode(text.slice(0, charIndex)).length;
  const byteEnd = byteStart + encoder.encode(url).length;

  return {
    features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    index: { byteEnd, byteStart },
  };
}

// Post a finding to @fluncle.bsky.social as an external link card. No-op when the
// credentials are unset (the whole feature ships dark until provisioned). On a
// real API failure it throws — mirroring postToTelegram — and the publish call
// site swallows it so a Bluesky hiccup never fails the publish.
export async function postToBluesky(
  track: TrackMetadata,
  note?: string,
  logId?: string,
): Promise<void> {
  const [identifier, appPassword] = await Promise.all([
    readOptionalEnv("BLUESKY_IDENTIFIER"),
    readOptionalEnv("BLUESKY_APP_PASSWORD"),
  ]);

  if (!identifier || !appPassword) {
    return;
  }

  const session = await createSession(identifier, appPassword);
  const post = formatBlueskyPost(track, note, logId);

  // Best-effort thumb: fetch the finding's OG card and upload it as a blob. A
  // miss (fetch/upload failure, oversize) drops the thumb rather than the post —
  // the card still resolves with its title + description.
  const thumb = logId?.trim()
    ? await uploadOgThumb(session, logId).catch(() => undefined)
    : undefined;

  const embed: ExternalEmbed = {
    $type: "app.bsky.embed.external",
    external: {
      description: post.external.description,
      title: post.external.title,
      uri: post.external.uri,
      ...(thumb ? { thumb } : {}),
    },
  };

  const record = {
    $type: "app.bsky.feed.post",
    createdAt: new Date().toISOString(),
    embed,
    langs: ["en"],
    text: post.text,
    ...(post.facets.length > 0 ? { facets: post.facets } : {}),
  };

  const response = await fetch(`${XRPC_BASE}/com.atproto.repo.createRecord`, {
    body: JSON.stringify({
      collection: "app.bsky.feed.post",
      record,
      repo: session.did,
    }),
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bluesky post failed: ${response.status} ${response.statusText} - ${body}`);
  }
}

// Exchange the identifier + app password for an access JWT + the account DID.
async function createSession(
  identifier: string,
  appPassword: string,
): Promise<CreateSessionResponse> {
  const response = await fetch(`${XRPC_BASE}/com.atproto.server.createSession`, {
    body: JSON.stringify({ identifier, password: appPassword }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bluesky session failed: ${response.status} ${response.statusText} - ${body}`);
  }

  return (await response.json()) as CreateSessionResponse;
}

// Fetch the finding's OG card (the same 1200×630 image the /log page points
// og:image at) and upload it as a blob for the card thumbnail. Throws on any
// non-2xx so the caller's `.catch` drops the thumb cleanly.
async function uploadOgThumb(session: CreateSessionResponse, logId: string): Promise<BlobRef> {
  const ogResponse = await fetch(`${siteUrl}/api/og/${encodeURIComponent(logId)}`);

  if (!ogResponse.ok) {
    throw new Error(`OG card fetch failed: ${ogResponse.status}`);
  }

  const mimeType = ogResponse.headers.get("content-type") ?? "image/png";
  const bytes = await ogResponse.arrayBuffer();

  const uploadResponse = await fetch(`${XRPC_BASE}/com.atproto.repo.uploadBlob`, {
    body: bytes,
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": mimeType,
    },
    method: "POST",
  });

  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    throw new Error(`Bluesky blob upload failed: ${uploadResponse.status} - ${body}`);
  }

  const payload = (await uploadResponse.json()) as { blob: BlobRef };

  return payload.blob;
}

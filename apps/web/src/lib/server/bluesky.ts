import { logPageUrl, siteUrl } from "../fluncle-links";
import { readOptionalEnv } from "./env";
import { type TrackMetadata } from "./spotify";

const XRPC_BASE = "https://bsky.social/xrpc";

const DEFAULT_CARD_DESCRIPTION = "Drum & bass bangers from another dimension.";

const notePrefix = "Why I'm playing it:";

type Facet = {
  index: { byteEnd: number; byteStart: number };
  features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string }>;
};

type ExternalEmbed = {
  $type: "app.bsky.embed.external";
  external: {
    description: string;
    thumb?: BlobRef;
    title: string;
    uri: string;
  };
};

type BlobRef = {
  $type: "blob";
  mimeType: string;
  ref: { $link: string };
  size: number;
};

type CreateSessionResponse = { accessJwt: string; did: string };

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

  const spotifyLine = `🎧 Spotify: ${track.spotifyUrl}`;
  lines.push("", spotifyLine);

  const text = lines.join("\n");
  const facets = [linkFacet(text, track.spotifyUrl)].filter((facet): facet is Facet =>
    Boolean(facet),
  );

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

export function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();

  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

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

  const session = await createSession(normalizeIdentifier(identifier), appPassword);
  const post = formatBlueskyPost(track, note, logId);

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

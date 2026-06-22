// Self-running checks for parseSpotifyTrackInput — no framework, mirroring the
// repo's node:assert test style (packages/contracts/src/orpc/feed-item.test.ts).
// Run via `bun test` (reports "0 pass" — no describe/it blocks — but throws and
// fails the process on a failed assertion) or `bun src/fluncle.test.ts`.
//
// parseSpotifyTrackInput guards what reaches the CLI: it accepts only a Spotify
// track URI or an open.spotify.com /track/ URL with a 22-char base62 id, and
// rejects everything else (wrong host, the wrong kind, a short id, junk). This is
// the only real logic in the Raycast extension, so pin both arms.

import assert from "node:assert/strict";

import { parseSpotifyTrackInput } from "./fluncle";

const TRACK_ID = "4cOdK2wGLETKBW3PvgPWqT"; // a real 22-char base62 Spotify id

// Accepted: the spotify:track:<22> URI, returned verbatim.
{
  const uri = `spotify:track:${TRACK_ID}`;
  assert.equal(parseSpotifyTrackInput(uri), uri, "spotify:track:<22> URI is accepted verbatim");
}

// Accepted: the open.spotify.com /track/<22> URL, returned verbatim.
{
  const url = `https://open.spotify.com/track/${TRACK_ID}`;
  assert.equal(parseSpotifyTrackInput(url), url, "open.spotify.com /track/<22> URL is accepted");
}

// Surrounding whitespace is trimmed before matching.
{
  const uri = `spotify:track:${TRACK_ID}`;
  assert.equal(parseSpotifyTrackInput(`  ${uri}\n`), uri, "leading/trailing whitespace is trimmed");
}

// A /track/ URL with query params is still accepted (returned as the trimmed input).
{
  const url = `https://open.spotify.com/track/${TRACK_ID}?si=abcdef`;
  assert.equal(parseSpotifyTrackInput(url), url, "a /track/ URL with a query is accepted");
}

// Rejected: the wrong host.
{
  assert.equal(
    parseSpotifyTrackInput(`https://spotify.com/track/${TRACK_ID}`),
    undefined,
    "spotify.com (not open.spotify.com) is rejected",
  );
  assert.equal(
    parseSpotifyTrackInput(`https://example.com/track/${TRACK_ID}`),
    undefined,
    "an unrelated host is rejected",
  );
}

// Rejected: a non-track Spotify resource (album/playlist).
{
  assert.equal(
    parseSpotifyTrackInput(`https://open.spotify.com/album/${TRACK_ID}`),
    undefined,
    "an /album/ URL is rejected",
  );
  assert.equal(
    parseSpotifyTrackInput(`spotify:album:${TRACK_ID}`),
    undefined,
    "a spotify:album: URI is rejected",
  );
}

// Rejected: a too-short track id (both forms).
{
  assert.equal(
    parseSpotifyTrackInput("spotify:track:abc"),
    undefined,
    "a short URI id is rejected",
  );
  assert.equal(
    parseSpotifyTrackInput("https://open.spotify.com/track/abc"),
    undefined,
    "a short URL id is rejected",
  );
}

// Rejected: a too-long track id (both forms).
{
  const tooLong = `${TRACK_ID}EXTRA`;
  assert.equal(
    parseSpotifyTrackInput(`spotify:track:${tooLong}`),
    undefined,
    "a long URI id is rejected",
  );
  assert.equal(
    parseSpotifyTrackInput(`https://open.spotify.com/track/${tooLong}`),
    undefined,
    "a long URL id is rejected",
  );
}

// Rejected: non-URL junk and empties.
{
  assert.equal(parseSpotifyTrackInput("not a url at all"), undefined, "free-text junk is rejected");
  assert.equal(parseSpotifyTrackInput(""), undefined, "an empty string is rejected");
  assert.equal(parseSpotifyTrackInput("https://"), undefined, "a bare scheme is rejected");
}

console.log(
  "✓ parseSpotifyTrackInput: accepts track URI/URL with a 22-char id, rejects wrong host/kind/length/junk",
);

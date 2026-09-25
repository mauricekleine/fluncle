import assert from "node:assert/strict";

import { parseSpotifyTrackInput } from "./fluncle";

const TRACK_ID = "4cOdK2wGLETKBW3PvgPWqT";

{
  const uri = `spotify:track:${TRACK_ID}`;
  assert.equal(
    parseSpotifyTrackInput(uri),
    uri,
    "spotify:track:<22> URI is accepted verbatim",
  );
}

{
  const url = `https://open.spotify.com/track/${TRACK_ID}`;
  assert.equal(
    parseSpotifyTrackInput(url),
    url,
    "open.spotify.com /track/<22> URL is accepted",
  );
}

{
  const uri = `spotify:track:${TRACK_ID}`;
  assert.equal(
    parseSpotifyTrackInput(`  ${uri}\n`),
    uri,
    "leading/trailing whitespace is trimmed",
  );
}

{
  const url = `https://open.spotify.com/track/${TRACK_ID}?si=abcdef`;
  assert.equal(
    parseSpotifyTrackInput(url),
    url,
    "a /track/ URL with a query is accepted",
  );
}

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

{
  assert.equal(
    parseSpotifyTrackInput("not a url at all"),
    undefined,
    "free-text junk is rejected",
  );
  assert.equal(
    parseSpotifyTrackInput(""),
    undefined,
    "an empty string is rejected",
  );
  assert.equal(
    parseSpotifyTrackInput("https://"),
    undefined,
    "a bare scheme is rejected",
  );
}

console.log(
  "✓ parseSpotifyTrackInput: accepts track URI/URL with a 22-char id, rejects wrong host/kind/length/junk",
);

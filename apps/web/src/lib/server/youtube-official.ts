// THE OFFICIALNESS GATE for a capture's YouTube provenance (operator ruling 2026-07-31).
//
// THE PROBLEM THIS SOLVES. The capture sweep finds a YouTube upload, downloads its audio, and
// fingerprints it against the ISRC-resolved official preview. A match proves the AUDIO is this
// recording — and nothing whatsoever about whether the upload is legitimate. A rip carries the
// same bytes as the master, which is precisely why the fingerprint accepts it. So the fingerprint
// answers "is this the right recording", and this module answers the separate question "may
// Fluncle be seen pointing at this upload". Only the second one is permission.
//
// THE SOURCE. YouTube's oEmbed endpoint, which needs NO key, no quota, and no API client:
// `https://www.youtube.com/oembed?url=…&format=json` returns the upload's `author_name` — its
// channel. That is the entire network cost of this gate, and it is the ONLY YouTube call the
// capture-provenance leg makes anywhere. The YouTube Data API is not used, here or elsewhere in
// this leg.
//
// THE BIAS IS DELIBERATE. Two rules accept, and everything else is refused:
//
//   1. An auto-generated `<Artist> - Topic` channel. These are Art Tracks — YouTube mints them
//      from the rights-holder's own delivered audio, so the channel's existence IS the licence.
//   2. A channel whose name FOLDS EQUAL to a name this recording is credited to. Exact equality
//      after the house fold, never a substring: "Netsky" accepts on Netsky's own channel, and
//      "Netsky Fan Rips" does not.
//
// That refuses plenty of genuinely official uploads — a label's channel (Hospital Records), a VEVO
// channel (`NetskyVEVO`), an alias, a channel that renamed itself. Every one of those is a FALSE
// NEGATIVE, and every one of them is FINE: the id is still kept as capture provenance, it simply
// stays internal and no reader is told anything. The asymmetry is the whole design — a missed
// official upload costs a link nobody sees, while a rip served as Fluncle's link is exactly the
// small dishonesty the /identity page exists to prevent. Widening this heuristic is a ruling, not
// a tidy-up.
//
// A VERDICT REQUIRES AN ANSWER. `null` is returned unless YouTube actually replied with a channel
// name — a 404, a 401 on a private video, a 5xx, a timeout, malformed JSON, all of it reads
// `null` = NOT YET CHECKED, never a guess in either direction. `null` renders nothing, so an
// unreachable check degrades into silence rather than into a claim.

import { fold } from "./track-match";

/** The stored verdict: 1 = may be shown, 0 = checked and refused, null = no check concluded. */
export type YoutubeOfficialVerdict = 0 | 1 | null;

// The auto-generated art-track channel marker, matched at the END of the channel name and tolerant
// of the spacing YouTube varies ("Netsky - Topic", "Chase & Status-Topic"). Anchored on purpose: a
// channel that merely CONTAINS the word ("Hot Topic Records") is not an Art Track. Mirrors
// `TOPIC_CHANNEL_MARKER` in docs/agents/hermes/scripts/capture-sweep.ts, where the same shape is a
// ranking tiebreak rather than a permission.
const TOPIC_CHANNEL_MARKER = /-\s*topic\s*$/i;

/** Whether a channel name is one of YouTube's auto-generated `<Artist> - Topic` art-track channels. */
export function isTopicChannel(authorName: string): boolean {
  return TOPIC_CHANNEL_MARKER.test(authorName.trim());
}

/**
 * THE PREDICATE, pure and unit-tested apart from the fetch. `authorName` is the upload's channel;
 * `artistNames` are the names this recording is credited to.
 *
 * `fold` is the house's canonical comparison form (lib/server/track-match.ts): lowercase, accents
 * stripped, `&` folded to `and`, punctuation dropped, whitespace collapsed. Comparing FOLDED
 * EQUALITY rather than containment is what keeps this conservative — the fold makes "Chase &
 * Status" meet "Chase and Status", and still refuses any channel that merely embeds an artist's
 * name inside a longer one.
 */
export function isOfficialAuthor(authorName: string, artistNames: readonly string[]): boolean {
  const author = authorName.trim();

  if (!author) {
    return false;
  }

  if (isTopicChannel(author)) {
    return true;
  }

  const foldedAuthor = fold(author);

  if (!foldedAuthor) {
    return false;
  }

  return artistNames.some((name) => {
    const foldedName = fold(name);

    return foldedName.length > 0 && foldedName === foldedAuthor;
  });
}

/** The oEmbed response, narrowed to the one field this gate reads. */
type OEmbedResponse = { author_name?: unknown };

// Short on purpose: this runs INSIDE the capture sweep's PATCH, so a slow YouTube must not hold a
// box write open. A timeout is simply an unconcluded check.
const OEMBED_TIMEOUT_MS = 5_000;

/**
 * Ask YouTube who uploaded `videoId`, and rule on it. Returns 1 (may be shown), 0 (checked and
 * refused), or null (no check concluded — the caller stores NULL and shows nothing).
 *
 * NEVER THROWS. Every failure path collapses to `null`, because this gate rides an unrelated write:
 * a capture that succeeded must land its bytes, its key, and its stamps even when YouTube is
 * unreachable. Losing a capture over an optional provenance lookup would be the worse bug.
 */
export async function checkYoutubeOfficial(
  videoId: string,
  artistNames: readonly string[],
  // Injectable for tests, so the predicate and the transport can be exercised without a network.
  fetchImpl: typeof fetch = fetch,
): Promise<YoutubeOfficialVerdict> {
  const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });

    // A 404 (gone), a 401 (private), a 5xx — none of them tells us WHO uploaded this, so none of
    // them is a verdict. The id stays stored and unchecked.
    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as OEmbedResponse;
    const authorName = typeof body.author_name === "string" ? body.author_name : "";

    // An answer with no channel name is not an answer to the question this gate asks.
    if (!authorName.trim()) {
      return null;
    }

    return isOfficialAuthor(authorName, artistNames) ? 1 : 0;
  } catch {
    return null;
  }
}

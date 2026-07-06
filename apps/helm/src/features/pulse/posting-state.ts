// The posting-state gatherer — the one impure read behind both the next-to-post
// card and the 18h nudge. It asks the Fluncle admin API (in-process, CLI-
// credentialled, server-side) for the recently-filmed findings and their social
// state, then hands the pure core (logic.ts) plain data. Everything here is a
// READ: the admin track list, each finding's per-platform posts, and the public
// note.txt bundle caption. Nothing is ever written from the helm.
//
// Cached with a short TTL so the panel's poll and the hourly nudge tick share one
// pass instead of hammering the admin API — one operator, one board.

import { type AdminClient } from "../types";
import { type NextToPostCard } from "./contract";
import {
  artistTitle,
  minutesSince,
  newestPostedAt,
  type PostingCandidate,
  postFreshness,
  type PostRecord,
  selectNextToPost,
} from "./logic";

// Public production hostnames (already the repo's FOUND_BASE / site base). The
// bundle assets live behind found.fluncle.com; the operator posts from the admin
// board and the finding's log page lives on the site.
const FOUND_BASE = "https://found.fluncle.com";
const SITE_BASE = "https://www.fluncle.com";

// The window of recently-filmed findings we inspect. Posting keeps pace with
// filming (TikTok caps unposted drafts at 5/24h), so the unposted findings cluster
// at the recent end — a page's worth is plenty to find the next one and to read
// the freshest post for the staleness clock.
const WINDOW = 24;
const CACHE_TTL_MS = 30_000;

/** The admin track fields the gatherer reads (a subset of the list response). */
type AdminTrack = {
  addedAt: string;
  albumImageUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
  type?: string;
  videoUrl?: string;
};

type AdminTracksResponse = {
  tracks: AdminTrack[];
};

type SocialResponse = {
  posts: PostRecord[];
};

/** What one gather pass produces — the pure inputs plus the enriched card. */
export type GatheredPosting = {
  candidates: PostingCandidate[];
  gatheredAt: number;
  newestPostedAt: number | null;
  nextToPost: NextToPostCard | undefined;
};

function foundAsset(logId: string, name: string): string {
  return `${FOUND_BASE}/${encodeURIComponent(logId)}/${name}`;
}

/** Read the bundle caption (note.txt) for one finding — public, read-only. */
async function readCaption(logId: string): Promise<string | null> {
  try {
    const response = await fetch(foundAsset(logId, "note.txt"), {
      signal: AbortSignal.timeout(4000),
    });
    const text = response.ok ? (await response.text()).trim() : "";

    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function gatherFresh(admin: AdminClient, now: number): Promise<GatheredPosting> {
  const listing = await admin.get<AdminTracksResponse>(
    `/api/admin/tracks?hasVideo=true&order=desc&limit=${WINDOW}`,
  );

  const findings = (listing.tracks ?? []).filter(
    (track): track is AdminTrack & { logId: string } =>
      track.type !== "mixtape" && typeof track.logId === "string" && track.logId.length > 0,
  );

  // Read each finding's social state in parallel. A read we can't complete is
  // treated as "posted" — we never surface or nudge a finding we can't confirm is
  // still waiting, so a transient admin blip can't manufacture a false nudge.
  const enriched = await Promise.all(
    findings.map(async (track) => {
      try {
        const social = await admin.get<SocialResponse>(
          `/api/admin/tracks/${encodeURIComponent(track.trackId)}/social`,
        );
        const { postedAt, postedToTikTok } = postFreshness(social.posts ?? [], now);

        return { candidate: toCandidate(track, postedAt, postedToTikTok), track };
      } catch {
        return { candidate: toCandidate(track, null, true), track };
      }
    }),
  );

  const candidates = enriched.map((entry) => entry.candidate);
  const selected = selectNextToPost(candidates);
  const selectedTrack = selected
    ? enriched.find((entry) => entry.candidate.logId === selected.logId)?.track
    : undefined;

  const nextToPost = selectedTrack ? await toCard(selectedTrack, now) : undefined;

  return {
    candidates,
    gatheredAt: now,
    newestPostedAt: newestPostedAt(candidates),
    nextToPost,
  };
}

function toCandidate(
  track: AdminTrack & { logId: string },
  postedAt: number | null,
  postedToTikTok: boolean,
): PostingCandidate {
  return {
    addedAt: track.addedAt,
    artists: track.artists,
    logId: track.logId,
    postedAt,
    postedToTikTok,
    title: track.title,
  };
}

async function toCard(track: AdminTrack & { logId: string }, now: number): Promise<NextToPostCard> {
  return {
    addedAt: track.addedAt,
    adminUrl: `${SITE_BASE}/admin`,
    ageMinutes: minutesSince(track.addedAt, now),
    artistTitle: artistTitle(track.artists, track.title),
    caption: await readCaption(track.logId),
    coverUrl: track.albumImageUrl,
    logId: track.logId,
    logUrl: `${SITE_BASE}/log/${encodeURIComponent(track.logId)}`,
    postAssetUrl: foundAsset(track.logId, "footage.social.mp4"),
    title: track.title,
  };
}

/**
 * The cached gatherer bound to one admin client. Returns the last pass within the
 * TTL, otherwise reads fresh. `force` skips the cache (the manual nudge check).
 */
export function createPostingGatherer(
  admin: AdminClient,
): (opts?: { force?: boolean }) => Promise<GatheredPosting> {
  let cache: GatheredPosting | undefined;

  return async (opts) => {
    const now = Date.now();

    if (!opts?.force && cache && now - cache.gatheredAt < CACHE_TTL_MS) {
      return cache;
    }

    cache = await gatherFresh(admin, now);

    return cache;
  };
}

// THE /plan ENRICHMENT — moved here from the glass seed (the bridge owns /plan on
// :4180; the glass keeps its standalone copy for bridge-less mode). Given a planned
// mixtape/plan logId, assemble the ordered, enriched tracklist the glass renders:
//
//   1. Members (order + logId/title/artists/durationMs/videoVehicle/grain/register)
//      come from the PUBLIC API — GET /api/tracks/<mixtapeLogId> returns the
//      MixtapeDTO with its members. A committed fixture is the offline fallback so
//      /plan always serves a full plan even with no network.
//   2. Each finding's palette + seed + Found date come from its props.json on R2
//      (found.fluncle.com/<logId>/props.json, open CORS).
//   3. Each finding's replay scene comes from its composition.tsx (also on R2),
//      resolved + classified by `scene.ts` (the dream-replay half).
//
// The result is the PlanEntry[] contract shape the glass consumes over /plan, and
// the ordered logId list the matcher fingerprints (`fingerprint.ts`).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type PlanEntry } from "../contract";
import { extractScene } from "./scene";

const WEB_BASE = process.env.FLUNCLE_WEB_BASE ?? "https://www.fluncle.com";
const FOUND_BASE = process.env.FLUNCLE_FOUND_BASE ?? "https://found.fluncle.com";
/** Mixtape #1 (019.F.1A) is the default plan — the set the matcher was calibrated on. */
export const DEFAULT_PLAN_MIXTAPE = process.env.FLUNCLE_PLAN_MIXTAPE ?? "019.F.1A";

/** The minimal member shape the enrichment needs from the public MixtapeDTO. */
type PlanMember = {
  logId: string;
  title: string;
  artists: string[];
  durationMs?: number;
  videoVehicle?: string;
  videoGrain?: string;
  videoRegister?: string;
};

/** Fetch a mixtape/plan's ordered members from the public API. */
async function fetchMembers(mixtapeLogId: string): Promise<PlanMember[] | null> {
  try {
    const res = await fetch(`${WEB_BASE}/api/tracks/${mixtapeLogId}`);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { mixtape?: { members?: PlanMember[] } };
    const members = body.mixtape?.members;
    return Array.isArray(members) && members.length > 0 ? members : null;
  } catch {
    return null;
  }
}

/** The committed offline fallback tracklist (public metadata; no signed preview URLs). */
async function fixtureMembers(): Promise<PlanMember[]> {
  const path = fileURLToPath(
    new URL(`./fixtures/plan-${DEFAULT_PLAN_MIXTAPE.replace(/\./g, "")}.json`, import.meta.url),
  );
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PlanMember[];
}

/** Enrich one member with palette/seed (props.json) + replay scene (composition.tsx). */
async function enrich(member: PlanMember): Promise<PlanEntry> {
  const entry: PlanEntry = {
    artists: member.artists,
    durationMs: member.durationMs,
    logId: member.logId,
    title: member.title,
    videoGrain: member.videoGrain,
    videoRegister: member.videoRegister,
    videoVehicle: member.videoVehicle,
  };

  // props.json -> palette + seed + Found date (+ authoritative title/artists/duration).
  try {
    const res = await fetch(`${FOUND_BASE}/${member.logId}/props.json`);
    if (res.ok) {
      const p = (await res.json()) as {
        palette?: PlanEntry["palette"];
        seed?: number;
        track?: { title?: string; artists?: string[]; discoveredAt?: string; durationMs?: number };
      };
      entry.palette = p.palette ?? entry.palette;
      entry.seed = p.seed ?? entry.seed;
      entry.title = p.track?.title ?? entry.title;
      entry.artists = p.track?.artists ?? entry.artists;
      entry.foundAt = p.track?.discoveredAt ?? entry.foundAt;
      entry.durationMs = p.track?.durationMs ?? entry.durationMs;
    }
  } catch {
    // props.json missing -> canon palette at render time (the glass falls back).
  }

  // composition.tsx -> the replay-ready scene (resolved body + classified uniforms).
  try {
    const res = await fetch(`${FOUND_BASE}/${member.logId}/composition.tsx`);
    if (res.ok) {
      const scene = extractScene(await res.text());
      entry.replay = {
        body: scene.body,
        customUniforms: scene.customUniforms,
        reason: scene.reason,
        replayable: scene.replayable,
      };
    } else {
      entry.replay = {
        customUniforms: [],
        reason: "composition.tsx unavailable",
        replayable: false,
      };
    }
  } catch {
    entry.replay = {
      customUniforms: [],
      reason: "composition.tsx fetch failed",
      replayable: false,
    };
  }

  return entry;
}

/**
 * Build the full enriched plan for a mixtape/plan logId. Members come from the API
 * (fixture fallback); each is enriched concurrently. This is the /plan payload and
 * the source of the matcher's ordered logId list.
 */
export async function buildPlan(mixtapeLogId = DEFAULT_PLAN_MIXTAPE): Promise<PlanEntry[]> {
  const members = (await fetchMembers(mixtapeLogId)) ?? (await fixtureMembers());
  return await Promise.all(members.map(enrich));
}

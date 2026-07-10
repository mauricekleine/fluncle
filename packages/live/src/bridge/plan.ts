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
//      resolved + classified by the glass's `scene-extract.ts` — the ONE extractor
//      in the package (multi-layer + velocity-pair aware, 17/17 replay). The bridge
//      reuses that pure module server-side instead of carrying a lagging duplicate;
//      the runtime boundary between the two PROCESSES stays contract.ts.
//
// The result is the PlanEntry[] contract shape the glass consumes over /plan, and
// the ordered logId list the matcher fingerprints (`fingerprint.ts`).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type PlanEntry, type PlanTexture } from "../contract";
import {
  extractScene,
  resolveSceneTextureUrls,
  type SceneTexture,
} from "../glass/scene-extract.ts";

/** Narrow resolved scene samplers to the contract's PlanTexture (url guaranteed present). */
function toPlanTextures(textures: SceneTexture[]): PlanTexture[] {
  return textures.flatMap((t) => (t.url ? [{ name: t.name, source: t.source, url: t.url }] : []));
}

const WEB_BASE = process.env.FLUNCLE_WEB_BASE ?? "https://www.fluncle.com";
const FOUND_BASE = process.env.FLUNCLE_FOUND_BASE ?? "https://found.fluncle.com";
/** Mixtape #1 (019.F.1A) is the default plan — the set the matcher was calibrated on. */
export const DEFAULT_PLAN_MIXTAPE = process.env.FLUNCLE_PLAN_MIXTAPE ?? "019.F.1A";

/** The minimal member shape the enrichment needs from the public MixtapeDTO. */
type PlanMember = {
  logId: string;
  title: string;
  artists: string[];
  /** Fluncle's stored DSP bpm + scale-text key — carried on the VJ-pool feed rows only, so
   * the deck-identity resolver can read them as coarse guards (see contract's PlanEntry). */
  bpm?: number | null;
  key?: string | null;
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

// ── Plan-ref routing: a mixtape logId OR a plan handle ───────────────────────
// The operator's live workflow is PLAN-first: a plan carries a galaxy-slug HANDLE (e.g.
// `dark-aurora-roller`, visible at /admin/plans) and exists BEFORE the set is played —
// exactly when the glass needs it. A `--plan` value is therefore either a mixtape/finding
// COORDINATE (`NNN.G.CC`) or a plan HANDLE; the shape decides which resolver runs. The
// coordinate path is the calibrated default; the handle path is the normal live flow.

/**
 * The RANDOM-VJ sentinel: `--plan all` (case-insensitive, whitespace-tolerant) is not a
 * mixtape/handle at all — it asks for the WHOLE archive as an unordered VJ pool. Both the
 * plan builder (`buildPlan`) and the bridge boot (`serve.ts`) route off this ONE predicate,
 * so the two never disagree on what counts as VJ mode. Pure, so it is unit-tested directly.
 */
export function isAllPlan(ref?: string): boolean {
  return ref?.trim().toLowerCase() === "all";
}

/**
 * A Fluncle coordinate (a finding OR a mixtape Log ID) looks like `NNN.G.CC` — three
 * digits, a galaxy char, a two-char cell (e.g. `019.F.1A`, `011.9.8I`). A PLAN handle is a
 * galaxy-vocab slug (e.g. `dark-aurora-roller`) and never matches this shape.
 */
export function isLogId(value: string): boolean {
  return /^[0-9]{3}\.[0-9A-Z]\.[0-9A-Z]{2}$/i.test(value.trim());
}

/**
 * True when a Log ID is a MIXTAPE coordinate — the galaxy char (the middle `G` of `NNN.G.CC`)
 * is `F`. Across the whole archive the galaxy chars are `0`–`9` for findings and exactly one
 * `F` for Fluncle's own mixtape, so this canonical marker (not an artist name or a null
 * enrichment status) is how the RANDOM-VJ pool excludes the mixtape. Pure + unit-tested.
 */
export function isMixtapeCoordinate(logId: string): boolean {
  const parts = logId.trim().toUpperCase().split(".");
  return parts.length === 3 && parts[1] === "F";
}

/** How a `--plan` value resolves: a mixtape/finding coordinate, or a plan handle. */
export type PlanRef = { kind: "logId"; value: string } | { kind: "handle"; value: string };

/**
 * Route a `--plan` value to its resolver. A coordinate (`isLogId`) is a MIXTAPE logId (the
 * `/api/tracks` mixtape route); anything else is a plan HANDLE (a galaxy slug — the normal
 * live flow). Pure, so the shape-detection + routing is unit-tested without the network.
 */
export function classifyPlanRef(value: string): PlanRef {
  const trimmed = value.trim();
  return isLogId(trimmed) ? { kind: "logId", value: trimmed } : { kind: "handle", value: trimmed };
}

/** Normalize a plan handle for comparison (case / space / underscore-insensitive slug). */
function normalizeHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** A plan candidate as the admin recordings list returns it (the fields we match on). */
export type PlanCandidate = { id: string; title: string; hasVideo?: boolean };

/**
 * Pick the plan whose galaxy-slug handle (its `title`) matches the requested handle. A PLAN
 * is videoless (`hasVideo !== true`); a take (with video) is never a plan, so it is excluded
 * even if its title collides. Pure + unit-tested (the resolution routing).
 */
export function matchPlanByHandle<T extends PlanCandidate>(
  candidates: readonly T[],
  handle: string,
): T | null {
  const want = normalizeHandle(handle);
  return candidates.find((c) => c.hasVideo !== true && normalizeHandle(c.title) === want) ?? null;
}

/**
 * Minimal `KEY=VALUE` .env parser (no dependency — the bridge reuses the CLI's stored
 * credential file read-only): quotes stripped, `#` comments + blanks skipped. Pure.
 */
export function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key !== "") {
      out[key] = val;
    }
  }
  return out;
}

/** The admin API base + bearer the plan-handle path reads (read-only). Exported so the
 * full-song fingerprinter (`fingerprint.ts`) can build an authorized `get_source_audio`
 * request against the SAME credential — the operator token the bridge already resolves. */
export type AdminAuth = { base: string; token: string };

/**
 * Resolve the admin API base + token the SAME way the fluncle CLI does — the bridge runs on
 * the operator's machine, so it reuses the CLI's stored credential: `process.env` first (the
 * box sets `FLUNCLE_API_TOKEN`), then `~/.config/fluncle/.env.production` (read-only). Returns
 * null when no token is reachable — the plan-handle path then holds + falls to the fixture,
 * and `boot()` falls back to preview fingerprinting (a token-less dev boot still works).
 */
export async function loadAdminAuth(): Promise<AdminAuth | null> {
  let token = process.env.FLUNCLE_API_TOKEN;
  let base = process.env.FLUNCLE_API_BASE_URL;
  if (!token) {
    try {
      const raw = await readFile(join(homedir(), ".config/fluncle/.env.production"), "utf8");
      const env = parseDotenv(raw);
      token ??= env.FLUNCLE_API_TOKEN;
      base ??= env.FLUNCLE_API_BASE_URL;
    } catch {
      // no stored credential file — token stays undefined
    }
  }
  if (!token) {
    return null;
  }
  return { base: (base ?? WEB_BASE).replace(/\/+$/, ""), token };
}

/** GET an admin JSON resource with the bearer; null on any non-OK / network fault. */
async function adminJson<T>(auth: AdminAuth, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${auth.base}${path}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Public track by id OR logId → the fields a PlanMember needs (`/api/tracks/{idOrLogId}`). */
async function fetchTrackMember(idOrLogId: string): Promise<PlanMember | null> {
  try {
    const res = await fetch(`${WEB_BASE}/api/tracks/${encodeURIComponent(idOrLogId)}`);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      track?: {
        logId?: string;
        title?: string;
        artists?: string[];
        durationMs?: number;
        videoVehicle?: string;
        videoGrain?: string;
        videoRegister?: string;
      };
    };
    const t = body.track;
    // A finding with no minted coordinate has no props.json/composition on R2 to enrich by,
    // so it can't ride the plan — skip it (rather than fabricate a key).
    if (!t?.logId) {
      return null;
    }
    return {
      artists: t.artists ?? [],
      durationMs: t.durationMs,
      logId: t.logId,
      title: t.title ?? "",
      videoGrain: t.videoGrain,
      videoRegister: t.videoRegister,
      videoVehicle: t.videoVehicle,
    };
  } catch {
    return null;
  }
}

/**
 * Members from a PLAN handle. Find the plan recording by its galaxy-slug handle (admin tier),
 * read its ordered cues, and map each finding-linked cue → a PlanMember (logId), in cue order,
 * through the SAME public track route the mixtape path enriches from. A free-text cue (no
 * `findingId`) has no finding to render/fingerprint, so it drops out. Null on any miss (no
 * token, no such plan, an empty/all-free-text tracklist) — the caller then holds loudly.
 */
async function fetchMembersByHandle(handle: string): Promise<PlanMember[] | null> {
  const auth = await loadAdminAuth();
  if (!auth) {
    console.error(
      `[hold]  plan handle "${handle}" needs the admin API — no FLUNCLE_API_TOKEN in the env ` +
        `or ~/.config/fluncle/.env.production.`,
    );
    return null;
  }
  const list = await adminJson<{ recordings?: Array<PlanCandidate & { tracklist?: unknown }> }>(
    auth,
    "/api/admin/recordings?kind=plan",
  );
  const plan = list?.recordings ? matchPlanByHandle(list.recordings, handle) : null;
  if (!plan) {
    return null;
  }
  const full = await adminJson<{ recording?: { tracklist?: Array<{ findingId?: string }> } }>(
    auth,
    `/api/admin/recordings/${encodeURIComponent(plan.id)}`,
  );
  const cues = full?.recording?.tracklist ?? [];
  const resolved = await Promise.all(
    cues.map((cue) => (cue.findingId ? fetchTrackMember(cue.findingId) : Promise.resolve(null))),
  );
  const members = resolved.filter((m): m is PlanMember => m !== null);
  return members.length > 0 ? members : null;
}

/** Enrich one member with palette/seed (props.json) + replay scene (composition.tsx). */
async function enrich(member: PlanMember): Promise<PlanEntry> {
  const entry: PlanEntry = {
    artists: member.artists,
    bpm: member.bpm,
    durationMs: member.durationMs,
    key: member.key,
    logId: member.logId,
    title: member.title,
    videoGrain: member.videoGrain,
    videoRegister: member.videoRegister,
    videoVehicle: member.videoVehicle,
  };

  // props.json -> palette + seed + Found date (+ authoritative title/artists/duration).
  // artworkUrl feeds any `source: "artwork"` texture sampler a composition declares.
  let artworkUrl: string | null = null;
  try {
    const res = await fetch(`${FOUND_BASE}/${member.logId}/props.json`);
    if (res.ok) {
      const p = (await res.json()) as {
        palette?: PlanEntry["palette"];
        seed?: number;
        track?: {
          title?: string;
          artists?: string[];
          discoveredAt?: string;
          durationMs?: number;
          artworkUrl?: string;
        };
      };
      entry.palette = p.palette ?? entry.palette;
      entry.seed = p.seed ?? entry.seed;
      entry.title = p.track?.title ?? entry.title;
      entry.artists = p.track?.artists ?? entry.artists;
      entry.foundAt = p.track?.discoveredAt ?? entry.foundAt;
      entry.durationMs = p.track?.durationMs ?? entry.durationMs;
      artworkUrl = p.track?.artworkUrl ?? null;
    }
  } catch {
    // props.json missing -> canon palette at render time (the glass falls back).
  }

  // scene.json -> the RENDERED palette stops (a composition may override the artwork
  // palette; the replay must re-tint with the rendered truth, not the artwork's).
  try {
    const res = await fetch(`${FOUND_BASE}/${member.logId}/scene.json`);
    if (res.ok) {
      const sc = (await res.json()) as { palette?: string[] };
      if (Array.isArray(sc.palette) && sc.palette.length >= 4) {
        entry.scenePalette = sc.palette;
      }
    }
  } catch {
    // scene.json missing -> the artwork palette carries the replay tint.
  }

  // composition.tsx -> the replay-ready scene (resolved layers + classified uniforms +
  // plate/artwork samplers resolved to concrete R2 URLs the glass loads).
  try {
    const res = await fetch(`${FOUND_BASE}/${member.logId}/composition.tsx`);
    if (res.ok) {
      const scene = resolveSceneTextureUrls(
        extractScene(await res.text()),
        member.logId,
        artworkUrl,
        FOUND_BASE,
      );
      entry.replay = {
        bloom: scene.bloom,
        body: scene.body,
        customUniforms: scene.customUniforms,
        dropShape: scene.dropShape,
        layers: scene.layers.map((layer) => ({
          blend: layer.blend,
          body: layer.body,
          customUniforms: layer.customUniforms,
          textures: toPlanTextures(layer.textures),
        })),
        reason: scene.reason,
        replayable: scene.replayable,
        textures: toPlanTextures(scene.textures),
        usesDrop: scene.usesDrop,
      };
    } else {
      entry.replay = {
        customUniforms: [],
        layers: [],
        reason: "composition.tsx unavailable",
        replayable: false,
      };
    }
  } catch {
    entry.replay = {
      customUniforms: [],
      layers: [],
      reason: "composition.tsx fetch failed",
      replayable: false,
    };
  }

  return entry;
}

/** Bounded-concurrency map — keeps the archive-wide VJ boot kind to prod + R2 (no thundering
 * herd) by running at most `limit` fetches at once, in order. Pure of the fetch specifics. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/** One public feed row (`/api/tracks`) — only the fields the VJ pool builds a member from.
 * `bpm`/`key` (Fluncle's DSP bpm + scale-text key) ride along as the resolver's coarse guards. */
type TrackFeedRow = {
  logId?: string;
  title?: string;
  artists?: string[];
  durationMs?: number;
  bpm?: number;
  key?: string;
};
/** A page of the public feed: the rows plus the opaque base64 cursor to the next page. */
type TrackFeedPage = { tracks?: TrackFeedRow[]; nextCursor?: string };

/** Feed page size + the pagination safety rail (the archive drains in ~2 pages of 100). */
const VJ_FEED_PAGE_LIMIT = 100;
const VJ_FEED_MAX_PAGES = 20;

/**
 * Drain the WHOLE public archive from the merged feed (`GET /api/tracks`), following
 * `nextCursor` page to page. The cursor is opaque base64 (it can contain `=` / `+` / `/`), so
 * it goes through `URLSearchParams`, which percent-encodes it — a raw `?cursor=` concat would
 * corrupt it. The feed rows carry the member metadata directly (`logId`/`title`/`artists`/
 * `durationMs`), so there is no per-id round-trip. Returns EVERY row — findings AND Fluncle's
 * own mixtape (`totalCount` counts findings, but the rows include the `F`-galaxy mixtape); the
 * caller filters mixtapes out. THROWS (naming the status / cause) on a thrown fetch or a non-OK
 * page — VJ mode has no fallback pool, so a swallowed failure would boot a dead, visual-less
 * show; `www.fluncle.com` fronts a Cloudflare rule that 403s crawler-ish user-agents, so this
 * genuinely can fail in the field, and failing fast + loud lets `main().catch` exit non-zero. A
 * pagination safety rail bounds the page count AND bails on a repeated cursor, so a server bug
 * can never spin the boot forever.
 */
export async function fetchAllArchiveRows(): Promise<TrackFeedRow[]> {
  const rows: TrackFeedRow[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < VJ_FEED_MAX_PAGES; page++) {
    const url = new URL(`${WEB_BASE}/api/tracks`);
    url.searchParams.set("limit", String(VJ_FEED_PAGE_LIMIT));
    if (cursor !== undefined) {
      url.searchParams.set("cursor", cursor); // URLSearchParams percent-encodes the base64
    }
    let res: Response;
    try {
      res = await fetch(url);
    } catch (cause) {
      throw new Error(`RANDOM-VJ: /api/tracks fetch failed (page ${page + 1})`, { cause });
    }
    if (!res.ok) {
      throw new Error(
        `RANDOM-VJ: /api/tracks returned ${res.status} ${res.statusText} (page ${page + 1}) — a ` +
          `Cloudflare user-agent/rule change can 403 the bridge; VJ mode needs the feed to enumerate the archive.`,
      );
    }
    const body = (await res.json()) as TrackFeedPage;
    for (const row of body.tracks ?? []) {
      rows.push(row);
    }
    const next = body.nextCursor;
    if (next === undefined || next === "") {
      return rows;
    }
    if (seenCursors.has(next)) {
      throw new Error(
        `RANDOM-VJ: /api/tracks returned a repeating cursor after ${page + 1} page(s) — refusing ` +
          `to page forever (server bug?).`,
      );
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error(
    `RANDOM-VJ: /api/tracks exceeded ${VJ_FEED_MAX_PAGES} pages — refusing to page forever (server bug?).`,
  );
}

/** A public feed row → a PlanMember (the fields the enrichment needs); null when it has no logId. */
function rowToMember(row: TrackFeedRow): PlanMember | null {
  if (!row.logId) {
    return null;
  }
  return {
    artists: row.artists ?? [],
    bpm: row.bpm ?? null,
    durationMs: row.durationMs,
    key: row.key ?? null,
    logId: row.logId,
    title: row.title ?? "",
  };
}

/**
 * The RANDOM-VJ pool (`--plan all`): the WHOLE archive as PlanEntries with NO order — the
 * bridge's shuffle-bag director (`vj.ts`) picks what shows next, driven by the DJ's transition
 * datagrams, so there is nothing to match and no order to keep. Findings whose composition
 * never rendered still ride as the default-vehicle morph (`enrich` marks them non-replayable).
 * Sourced from the paginated public feed (`fetchAllArchiveRows`), with **Fluncle's own mixtape
 * excluded** (`isMixtapeCoordinate` — the pool is the ~60 findings, never the `F`-galaxy set).
 * The feed rows already carry the member metadata, so only the per-finding `enrich` (which needs
 * `found.fluncle.com`) hits the network again, at bounded concurrency (8). THROWS on a failed
 * feed fetch (via `fetchAllArchiveRows`) OR an empty resolved pool — VJ mode has no fallback
 * tracklist, so an empty pool must fail loudly (`main().catch` exits non-zero) rather than boot
 * a visual-less show the operator can't drive.
 */
export async function buildAllFindingsPlan(): Promise<PlanEntry[]> {
  const rows = await fetchAllArchiveRows();
  const members = rows
    .map(rowToMember)
    .filter((m): m is PlanMember => m !== null && !isMixtapeCoordinate(m.logId));
  const plan = await mapLimit(members, 8, enrich);
  if (plan.length === 0) {
    throw new Error(
      `RANDOM-VJ: the archive pool is empty — the feed yielded ${rows.length} row(s), ` +
        `${members.length} of which resolved to non-mixtape findings. VJ mode has nothing to show; ` +
        `refusing to boot a dead show. Check ${WEB_BASE}/api/tracks.`,
    );
  }
  return plan;
}

/**
 * Build the full enriched plan for a `--plan` value — the RANDOM-VJ pool (`all`, the WHOLE
 * archive, unordered), a MIXTAPE logId (the calibrated default), OR a plan HANDLE (a galaxy
 * slug, the normal live flow). The shape routes the resolver; the ordered paths take members
 * from the API (committed fixture fallback) and enrich each concurrently. This is the /plan
 * payload and the source of the matcher's ordered logId list (empty for the VJ pool).
 */
export async function buildPlan(planRef = DEFAULT_PLAN_MIXTAPE): Promise<PlanEntry[]> {
  if (isAllPlan(planRef)) {
    return await buildAllFindingsPlan();
  }
  const ref = classifyPlanRef(planRef);
  const requested = ref.kind === "handle" ? `plan handle "${ref.value}"` : `mixtape ${ref.value}`;
  const fetched =
    ref.kind === "handle" ? await fetchMembersByHandle(ref.value) : await fetchMembers(ref.value);
  const members = fetched ?? (await fixtureMembers());
  // Never silently swap the tracklist: if the requested plan didn't load, say so loudly
  // (the show.ts `[hold]` register) — naming what was asked for vs. what actually ran.
  if (fetched === null) {
    console.error(
      `[hold]  ${requested} did not resolve — falling back to the committed fixture ` +
        `(${DEFAULT_PLAN_MIXTAPE}, ${members.length} findings). ` +
        `The glass is running the FIXTURE tracklist, not ${ref.value}.`,
    );
  }
  return await Promise.all(members.map(enrich));
}

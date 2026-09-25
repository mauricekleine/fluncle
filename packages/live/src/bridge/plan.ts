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

function toPlanTextures(textures: SceneTexture[]): PlanTexture[] {
  return textures.flatMap((t) => (t.url ? [{ name: t.name, source: t.source, url: t.url }] : []));
}

const WEB_BASE = process.env.FLUNCLE_WEB_BASE ?? "https://www.fluncle.com";
const FOUND_BASE = process.env.FLUNCLE_FOUND_BASE ?? "https://found.fluncle.com";

export const DEFAULT_PLAN_MIXTAPE = process.env.FLUNCLE_PLAN_MIXTAPE ?? "019.F.1A";

type PlanMember = {
  logId: string;
  title: string;
  artists: string[];

  bpm?: number | null;
  key?: string | null;
  durationMs?: number;
  videoVehicle?: string;
  videoGrain?: string;
  videoRegister?: string;
};

async function fetchMembers(mixtapeLogId: string): Promise<PlanMember[] | null> {
  try {
    const res = await fetch(`${WEB_BASE}/api/v1/tracks/${mixtapeLogId}`);
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

async function fixtureMembers(): Promise<PlanMember[]> {
  const path = fileURLToPath(
    new URL(`./fixtures/plan-${DEFAULT_PLAN_MIXTAPE.replace(/\./g, "")}.json`, import.meta.url),
  );
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PlanMember[];
}

export function isAllPlan(ref?: string): boolean {
  return ref?.trim().toLowerCase() === "all";
}

export function isLogId(value: string): boolean {
  return /^[0-9]{3}\.[0-9A-Z]\.[0-9A-Z]{2}$/i.test(value.trim());
}

export function isMixtapeCoordinate(logId: string): boolean {
  const parts = logId.trim().toUpperCase().split(".");
  return parts.length === 3 && parts[1] === "F";
}

export type PlanRef = { kind: "logId"; value: string } | { kind: "handle"; value: string };

export function classifyPlanRef(value: string): PlanRef {
  const trimmed = value.trim();
  return isLogId(trimmed) ? { kind: "logId", value: trimmed } : { kind: "handle", value: trimmed };
}

function normalizeHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export type PlanCandidate = { id: string; title: string; hasVideo?: boolean };

export function matchPlanByHandle<T extends PlanCandidate>(
  candidates: readonly T[],
  handle: string,
): T | null {
  const want = normalizeHandle(handle);
  return candidates.find((c) => c.hasVideo !== true && normalizeHandle(c.title) === want) ?? null;
}

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

export type AdminAuth = { base: string; token: string };

export async function loadAdminAuth(): Promise<AdminAuth | null> {
  let token = process.env.FLUNCLE_API_TOKEN;
  let base = process.env.FLUNCLE_API_BASE_URL;
  if (!token) {
    try {
      const raw = await readFile(join(homedir(), ".config/fluncle/.env.production"), "utf8");
      const env = parseDotenv(raw);
      token ??= env.FLUNCLE_API_TOKEN;
      base ??= env.FLUNCLE_API_BASE_URL;
    } catch {}
  }
  if (!token) {
    return null;
  }
  return { base: (base ?? WEB_BASE).replace(/\/+$/, ""), token };
}

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

async function fetchTrackMember(idOrLogId: string): Promise<PlanMember | null> {
  try {
    const res = await fetch(`${WEB_BASE}/api/v1/tracks/${encodeURIComponent(idOrLogId)}`);
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
    "/api/v1/admin/recordings?kind=plan",
  );
  const plan = list?.recordings ? matchPlanByHandle(list.recordings, handle) : null;
  if (!plan) {
    return null;
  }
  const full = await adminJson<{ recording?: { tracklist?: Array<{ findingId?: string }> } }>(
    auth,
    `/api/v1/admin/recordings/${encodeURIComponent(plan.id)}`,
  );
  const cues = full?.recording?.tracklist ?? [];
  const resolved = await Promise.all(
    cues.map((cue) => (cue.findingId ? fetchTrackMember(cue.findingId) : Promise.resolve(null))),
  );
  const members = resolved.filter((m): m is PlanMember => m !== null);
  return members.length > 0 ? members : null;
}

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
  } catch {}

  try {
    const res = await fetch(`${FOUND_BASE}/${member.logId}/scene.json`);
    if (res.ok) {
      const sc = (await res.json()) as { palette?: string[] };
      if (Array.isArray(sc.palette) && sc.palette.length >= 4) {
        entry.scenePalette = sc.palette;
      }
    }
  } catch {}

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

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

type TrackFeedRow = {
  logId?: string;
  title?: string;
  artists?: string[];
  durationMs?: number;
  bpm?: number;
  key?: string;
};

type TrackFeedPage = { tracks?: TrackFeedRow[]; nextCursor?: string };

const VJ_FEED_PAGE_LIMIT = 100;
const VJ_FEED_MAX_PAGES = 20;

export async function fetchAllArchiveRows(): Promise<TrackFeedRow[]> {
  const rows: TrackFeedRow[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < VJ_FEED_MAX_PAGES; page++) {
    const url = new URL(`${WEB_BASE}/api/v1/findings`);
    url.searchParams.set("limit", String(VJ_FEED_PAGE_LIMIT));
    if (cursor !== undefined) {
      url.searchParams.set("cursor", cursor);
    }
    let res: Response;
    try {
      res = await fetch(url);
    } catch (cause) {
      throw new Error(`RANDOM-VJ: /api/v1/findings fetch failed (page ${page + 1})`, { cause });
    }
    if (!res.ok) {
      throw new Error(
        `RANDOM-VJ: /api/v1/findings returned ${res.status} ${res.statusText} (page ${page + 1}) — a ` +
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
        `RANDOM-VJ: /api/v1/findings returned a repeating cursor after ${page + 1} page(s) — refusing ` +
          `to page forever (server bug?).`,
      );
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error(
    `RANDOM-VJ: /api/v1/findings exceeded ${VJ_FEED_MAX_PAGES} pages — refusing to page forever (server bug?).`,
  );
}

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
        `refusing to boot a dead show. Check ${WEB_BASE}/api/v1/findings.`,
    );
  }
  return plan;
}

export async function buildPlan(planRef = DEFAULT_PLAN_MIXTAPE): Promise<PlanEntry[]> {
  if (isAllPlan(planRef)) {
    return await buildAllFindingsPlan();
  }
  const ref = classifyPlanRef(planRef);
  const requested = ref.kind === "handle" ? `plan handle "${ref.value}"` : `mixtape ${ref.value}`;
  const fetched =
    ref.kind === "handle" ? await fetchMembersByHandle(ref.value) : await fetchMembers(ref.value);
  const members = fetched ?? (await fixtureMembers());

  if (fetched === null) {
    console.error(
      `[hold]  ${requested} did not resolve — falling back to the committed fixture ` +
        `(${DEFAULT_PLAN_MIXTAPE}, ${members.length} findings). ` +
        `The glass is running the FIXTURE tracklist, not ${ref.value}.`,
    );
  }
  return await Promise.all(members.map(enrich));
}

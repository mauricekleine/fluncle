#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

import { getDb, getOrSet, slugify } from "./lib";

const MB_USER_AGENT = "Fluncle-CatalogueAudit/1.0 (https://www.fluncle.com)";

const MB_INTERVAL_MS = 1200;

const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

export type ArtistRow = { id: string; mbid: null | string; name: string; slug: string };
export type LabelRow = { id: string; name: string; seed_state: string; slug: string };
export type TrackRow = {
  artist_credits_backfilled_at: null | string;
  artist_edges_backfilled_at: null | string;
  artists_json: string;
  label: null | string;
  label_id: null | string;
  mb_recording_id: null | string;
  title: null | string;
  track_id: string;
};

export type EdgeWriter = "crawl-link" | "credit-sweep" | "slice-0";

export function edgeWriter(track: TrackRow): EdgeWriter {
  if (track.artist_credits_backfilled_at) {
    return "credit-sweep";
  }

  return track.artist_edges_backfilled_at ? "slice-0" : "crawl-link";
}

export function namesakeLabelSlugs(
  rows: ReadonlyArray<{ label_slug: null | string }>,
): Set<string> {
  return new Set(rows.map((row) => row.label_slug).filter((slug): slug is string => Boolean(slug)));
}

export type Side = {
  creditSpellings: string[];
  labels: string[];
  sampleTitles: string[];
  trackIds: string[];
  tracks: number;
  writers: EdgeWriter[];
};

export type Candidate = {
  artist: ArtistRow;
  clean: Side;
  impostor: Side;
};

const emptySide = (): Side => ({
  creditSpellings: [],
  labels: [],
  sampleTitles: [],
  trackIds: [],
  tracks: 0,
  writers: [],
});

function matchingSpellings(track: TrackRow, artist: ArtistRow): string[] {
  let credited: unknown;

  try {
    credited = JSON.parse(track.artists_json);
  } catch {
    return [];
  }

  if (!Array.isArray(credited)) {
    return [];
  }

  const target = slugify(artist.name);

  return credited.filter(
    (name): name is string => typeof name === "string" && slugify(name) === target,
  );
}

export function buildCandidates(input: {
  artists: ReadonlyArray<ArtistRow>;
  edges: ReadonlyArray<{ artist_id: string; track_id: string }>;
  findingTrackIds: ReadonlySet<string>;
  labels: ReadonlyArray<LabelRow>;
  namesakeSlugs: ReadonlySet<string>;
  tracks: ReadonlyArray<TrackRow>;
}): Candidate[] {
  const { artists, edges, findingTrackIds, labels, namesakeSlugs, tracks } = input;
  const labelById = new Map(labels.map((label) => [label.id, label]));
  const enabledSlugs = new Set(
    labels.filter((label) => label.seed_state === "enabled").map((label) => label.slug),
  );
  const trackById = new Map(tracks.map((track) => [track.track_id, track]));
  const artistById = new Map(artists.map((artist) => [artist.id, artist]));
  const sides = new Map<string, { clean: Side; impostor: Side }>();

  for (const edge of edges) {
    const track = trackById.get(edge.track_id);
    const artist = artistById.get(edge.artist_id);

    if (!track || !artist) {
      continue;
    }

    if (findingTrackIds.has(track.track_id)) {
      continue;
    }

    const labelSlug = track.label_id
      ? (labelById.get(track.label_id)?.slug ?? slugify(track.label))
      : slugify(track.label);
    const isImpostor = namesakeSlugs.has(labelSlug);

    if (!isImpostor && !enabledSlugs.has(labelSlug)) {
      continue;
    }

    const bucket = getOrSet(sides, artist.id, () => ({
      clean: emptySide(),
      impostor: emptySide(),
    }));
    const side = isImpostor ? bucket.impostor : bucket.clean;
    side.tracks += 1;
    side.trackIds.push(track.track_id);
    side.writers.push(edgeWriter(track));

    if (track.label && !side.labels.includes(track.label)) {
      side.labels.push(track.label);
    }

    if (track.title && side.sampleTitles.length < 6) {
      side.sampleTitles.push(track.title);
    }

    for (const spelling of matchingSpellings(track, artist)) {
      if (!side.creditSpellings.includes(spelling)) {
        side.creditSpellings.push(spelling);
      }
    }
  }

  const candidates: Candidate[] = [];

  for (const [artistId, bucket] of sides) {
    const artist = artistById.get(artistId);

    if (artist && bucket.impostor.tracks > 0 && bucket.clean.tracks > 0) {
      candidates.push({ artist, clean: bucket.clean, impostor: bucket.impostor });
    }
  }

  return candidates.sort((a, b) => b.impostor.tracks - a.impostor.tracks);
}

export type RecordingCredits = { ids: string[]; names: string[] };
export type CreditLookup = (recordingMbid: string) => Promise<RecordingCredits | null>;

export type SideIdentity = { ids: string[]; names: string[]; sampled: number };

export async function identifySide(
  side: Side,
  tracks: ReadonlyMap<string, TrackRow>,
  lookup: CreditLookup,
  samples: number,
): Promise<SideIdentity> {
  const ids = new Set<string>();
  const names = new Set<string>();
  let sampled = 0;

  for (const trackId of side.trackIds) {
    if (sampled >= samples) {
      break;
    }

    const mbid = tracks.get(trackId)?.mb_recording_id;

    if (!mbid) {
      continue;
    }

    const credits = await lookup(mbid);
    sampled += 1;

    if (!credits) {
      continue;
    }

    for (const id of credits.ids) {
      ids.add(id);
    }

    for (const name of credits.names) {
      names.add(name);
    }
  }

  return { ids: [...ids], names: [...names], sampled };
}

export type Verdict = "CONFLATION (proven)" | "crossover (proven)" | "unsure";

export function verdictFor(impostor: SideIdentity, clean: SideIdentity): Verdict {
  if (impostor.ids.length === 0 || clean.ids.length === 0) {
    return "unsure";
  }

  return impostor.ids.some((id) => clean.ids.includes(id))
    ? "crossover (proven)"
    : "CONFLATION (proven)";
}

export function localSignals(candidate: Candidate): string[] {
  const signals: string[] = [];
  const writers = new Set(candidate.impostor.writers);

  if (writers.size === 1 && writers.has("credit-sweep")) {
    signals.push(
      "every impostor-side edge came from the mbid-keyed credit sweep — that path refuses homonyms, so this is probably a REAL crossover",
    );
  }

  if (writers.has("crawl-link") || writers.has("slice-0")) {
    signals.push(
      `impostor-side edges written by name-only paths: ${[...writers].filter((w) => w !== "credit-sweep").join(", ")}`,
    );
  }

  const impostorSpellings = new Set(candidate.impostor.creditSpellings);
  const cleanSpellings = new Set(candidate.clean.creditSpellings);
  const divergent = [...impostorSpellings].filter((s) => !cleanSpellings.has(s));

  if (divergent.length > 0 && cleanSpellings.size > 0) {
    signals.push(
      `credit spelling DIVERGES across the two sides (${[...cleanSpellings].join(" / ")} vs ${divergent.join(" / ")}) — the punctuation-fold fingerprint`,
    );
  }

  if (!candidate.artist.mbid) {
    signals.push("the artists row carries NO mbid, so no identity is claimed on either side");
  }

  return signals;
}

export type Evidence = {
  candidate: Candidate;
  cleanIdentity: SideIdentity;
  impostorIdentity: SideIdentity;
  verdict: Verdict;
};

const list = (values: string[], max = 6): string =>
  values.length === 0 ? "(none)" : values.slice(0, max).join(", ");

export function renderEvidence(evidence: Evidence): string {
  const { candidate, cleanIdentity, impostorIdentity, verdict } = evidence;
  const { artist, clean, impostor } = candidate;
  const lines = [
    `\n── ${artist.name}  (${artist.slug})  ·  ${verdict}`,
    `   artists.mbid: ${artist.mbid ?? "(none)"}`,
    `   IMPOSTOR SIDE  ${impostor.tracks} tracks  labels: ${list(impostor.labels)}`,
    `      credited as: ${list(impostor.creditSpellings)}`,
    `      titles:      ${list(impostor.sampleTitles, 4)}`,
    `      edge writer: ${list([...new Set(impostor.writers)])}`,
    `      MusicBrainz: ${list(impostorIdentity.names)}  ${list(impostorIdentity.ids, 3)}`,
    `   CLEAN SIDE     ${clean.tracks} tracks  labels: ${list(clean.labels)}`,
    `      credited as: ${list(clean.creditSpellings)}`,
    `      titles:      ${list(clean.sampleTitles, 4)}`,
    `      edge writer: ${list([...new Set(clean.writers)])}`,
    `      MusicBrainz: ${list(cleanIdentity.names)}  ${list(cleanIdentity.ids, 3)}`,
  ];

  for (const signal of localSignals(candidate)) {
    lines.push(`   · ${signal}`);
  }

  return lines.join("\n");
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
};

const numberFlag = (argv: string[], name: string, fallback: number): number => {
  const raw = flag(argv, name);
  const value = raw ? Number(raw) : Number.NaN;

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export function createCreditLookup(): CreditLookup {
  const cache = new Map<string, RecordingCredits | null>();
  let chain: Promise<unknown> = Promise.resolve();

  return async (recordingMbid) => {
    const held = cache.get(recordingMbid);

    if (held !== undefined) {
      return held;
    }

    const run = chain.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, MB_INTERVAL_MS));
      const url = `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(recordingMbid)}?inc=artist-credits&fmt=json`;
      const response = await fetch(url, { headers: { "User-Agent": MB_USER_AGENT } });

      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as {
        "artist-credit"?: { artist?: { id?: string; name?: string } }[];
      };
      const credits = body["artist-credit"] ?? [];
      const ids: string[] = [];
      const names: string[] = [];

      for (const credit of credits) {
        const id = credit.artist?.id;
        const name = credit.artist?.name;

        if (id && id !== VARIOUS_ARTISTS_MBID) {
          ids.push(id);
        }

        if (name) {
          names.push(name);
        }
      }

      return { ids, names };
    });

    chain = run.catch(() => undefined);
    const credits = await run.catch(() => null);
    cache.set(recordingMbid, credits);

    return credits;
  };
}

type Loaded = {
  artists: ArtistRow[];
  edges: { artist_id: string; track_id: string }[];
  findingTrackIds: Set<string>;
  labels: LabelRow[];
  namesakeSlugs: Set<string>;
  tracks: TrackRow[];
};

export async function load(labelsOverride?: string[]): Promise<Loaded> {
  const db = await getDb();
  const rows = async <T>(sql: string): Promise<T[]> => (await db.execute(sql)).rows as T[];
  const namesakeSlugs =
    labelsOverride && labelsOverride.length > 0
      ? new Set(labelsOverride.map((slug) => slugify(slug)))
      : namesakeLabelSlugs(
          await rows<{ label_slug: null | string }>(
            `select label_slug from crawl_frontier
              where kind = 'label' and note like '%namesake%'`,
          ),
        );

  return {
    artists: await rows<ArtistRow>(`select id, name, slug, mbid from artists`),
    edges: await rows(`select artist_id, track_id from track_artists`),
    findingTrackIds: new Set(
      (await rows<{ track_id: string }>(`select track_id from findings`)).map((r) => r.track_id),
    ),
    labels: await rows<LabelRow>(`select id, slug, name, seed_state from labels`),
    namesakeSlugs,
    tracks: await rows<TrackRow>(
      `select track_id, title, label, label_id, artists_json, mb_recording_id,
              artist_edges_backfilled_at, artist_credits_backfilled_at
         from tracks`,
    ),
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: { load?: typeof load; lookup?: CreditLookup } = {},
): Promise<number> {
  const useMb = !argv.includes("--no-musicbrainz");
  const samples = numberFlag(argv, "--samples", 2);
  const limit = numberFlag(argv, "--limit", 200);
  const labelsRaw = flag(argv, "--labels");
  const out = process.env.PRUNE_OUT_DIR ?? ".";

  const loaded = await (deps.load ?? load)(
    labelsRaw
      ? labelsRaw
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

  console.log(`\n===== CONFLATED-ARTIST DETECTOR (read-only) =====`);
  console.log(`impostor-walk labels: ${list([...loaded.namesakeSlugs], 20)}`);

  if (loaded.namesakeSlugs.size === 0) {
    console.log(
      `\nNo impostor-walk labels found. Either no namesake has been repaired yet (the frontier` +
        ` carries the record — see SKILL.md § Namesake repair) or you meant to pass --labels.`,
    );

    return 0;
  }

  const candidates = buildCandidates(loaded).slice(0, limit);
  console.log(`candidates (impostor-side AND clean-side tracks): ${candidates.length}`);

  const trackById = new Map(loaded.tracks.map((track) => [track.track_id, track]));
  const lookup = deps.lookup ?? (useMb ? createCreditLookup() : async () => null);

  if (useMb) {
    const calls = candidates.length * samples * 2;
    console.log(
      `MusicBrainz: up to ${calls} paced lookups (~${Math.ceil((calls * MB_INTERVAL_MS) / 60_000)} min). --no-musicbrainz skips them.`,
    );
  }

  const report: Evidence[] = [];

  for (const candidate of candidates) {
    const impostorIdentity = await identifySide(candidate.impostor, trackById, lookup, samples);
    const cleanIdentity = await identifySide(candidate.clean, trackById, lookup, samples);
    const evidence = {
      candidate,
      cleanIdentity,
      impostorIdentity,
      verdict: verdictFor(impostorIdentity, cleanIdentity),
    };
    report.push(evidence);
    console.log(renderEvidence(evidence));
  }

  const tally = new Map<Verdict, number>();

  for (const evidence of report) {
    tally.set(evidence.verdict, (tally.get(evidence.verdict) ?? 0) + 1);
  }

  console.log(`\n===== TALLY =====`);

  for (const [verdict, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)} · ${verdict}`);
  }

  const path = `${out}/conflated-artists.json`;
  writeFileSync(
    path,
    JSON.stringify(
      report.map((evidence) => ({
        clean: evidence.candidate.clean,
        cleanMusicBrainz: evidence.cleanIdentity,
        impostor: evidence.candidate.impostor,
        impostorMusicBrainz: evidence.impostorIdentity,
        mbid: evidence.candidate.artist.mbid,
        name: evidence.candidate.artist.name,
        signals: localSignals(evidence.candidate),
        slug: evidence.candidate.artist.slug,
        verdict: evidence.verdict,
      })),
      null,
      2,
    ),
  );
  console.log(`\nevidence → ${path}`);
  console.log(
    `Rule each one by hand, then repair with split-artist.ts. Nothing was written to prod.`,
  );

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

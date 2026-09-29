import { spawn } from "node:child_process";
import { type LabelAdminItem } from "@fluncle/contracts";
import {
  createEvidenceHttp,
  EvidenceFetchError,
  type EvidenceHttp,
  type EvidenceSource,
  fetchEvidenceJson,
  fetchEvidenceText,
  type RawResponse,
} from "../evidence-http";

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MB_ROOT = "https://musicbrainz.org/ws/2";
const DISCOGS_ROOT = "https://api.discogs.com";
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";
const RELEASE_SAMPLE = 12;
const FIRST_CREDIT_ARTISTS = 25;
const APPLE_LOOKUPS = 5;
const DISCOGS_RELEASE_SAMPLE = 8;
const DISCOGS_STYLE_TARGET = 10;
const DISCOGS_RELEASE_READS = 8;
const PROFILE_CHARS = 800;

export const EVIDENCE_SOURCES = ["musicbrainz", "discogs", "beatport", "apple"] as const;
export const MAX_CENSUS_PAGES = 5;

export type SourceStatus = "error" | "no_link" | "not_configured" | "ok" | "partial" | "skipped";

export type SourceFailure = {
  attempts?: number;
  kind: string;
  message: string;
  request: string;
  status?: number;
};

export type SourceReport<T> = {
  cached?: boolean;
  data?: T;
  errors?: SourceFailure[];
  note?: string;
  status: SourceStatus;
};

export type Count = { count: number; name: string };

export type MbLabelFacts = {
  area: null | string;
  country: null | string;
  disambiguation: null | string;
  genres: string[];
  labelCode: null | number;
  labelRelations: Array<{ direction: string; mbid: string; name: string; type: string }>;
  lifeSpan: { begin: null | string; end: null | string; ended: boolean };
  links: Array<{ type: string; url: string }>;
  mbid: string;
  name: string;
  tags: string[];
  type: null | string;
};

export type MbReleaseSample = {
  artist: string;
  barcode: null | string;
  catno: null | string;
  date: null | string;
  format: null | string;
  mbid: string;
  status: null | string;
  title: string;
};

export type MbReleaseFacts = {
  firstCreditArtists: Array<{ mbid: string; name: string; releases: number }>;
  releaseCount: number;
  releases: MbReleaseSample[];
  releasesRead: number;
  variousArtistsReleases: number;
};

export type MbCensus = {
  caveat: null | string;
  firstCredits: Array<{ artistMbid: string; artistName: string; recordings: number }>;
  pagesFetched: number;
  recordingsCounted: number;
  releaseCount: number;
  releasesRead: number;
  sampled: boolean;
};

export type MusicBrainzEvidence = {
  census?: MbCensus;
  label?: MbLabelFacts;
  releases?: MbReleaseFacts;
};

export type DiscogsEvidence = {
  candidates?: Array<{ id: number; title: string; url: string }>;
  label?: {
    id: number;
    name: string;
    parentLabel: null | { id: number; name: string };
    profile: string;
    sublabelCount: number;
    sublabels: string[];
    url: string;
    urls: string[];
  };
  releases?: {
    releaseCount: number;
    sample: Array<{
      artist: string;
      catno: null | string;
      format: null | string;
      title: string;
      year: null | number;
    }>;
    topArtists: Array<{ name: string; releases: number }>;
  };
  styles?: {
    genres: Count[];
    labelReleasesListed: number;
    releasesRead: number;
    styles: Count[];
    viaRelease: number;
    viaSearch: number;
  };
};

export type BeatportEvidence = {
  genres: Array<Count & { share: number }>;
  labelUrl: string;
  subGenres: Count[];
  topArtists: Count[];
  trackCount: number;
  tracksUrl: string;
};

export type AppleEvidence = {
  found: number;
  genres: Count[];
  looked: number;
  releases: Array<{
    artistName?: string;
    barcode: string;
    collectionName?: string;
    copyright?: string;
    found: boolean;
    mbTitle: string;
    primaryGenreName?: string;
  }>;
};

export type LabelEvidence = {
  errors: Array<SourceFailure & { source: EvidenceSource }>;
  fetchedAt: string;
  label: {
    id?: string;
    input: string;
    mbLabelId: string;
    name?: string;
    seedState?: string;
    slug?: string;
  };
  ok: boolean;
  partial: boolean;
  requests: { cacheHits: number; network: number };
  sources: {
    apple: SourceReport<AppleEvidence>;
    beatport: SourceReport<BeatportEvidence>;
    discogs: SourceReport<DiscogsEvidence>;
    musicbrainz: SourceReport<MusicBrainzEvidence>;
  };
};

export type BeatportScraper = (url: string, signal: AbortSignal) => Promise<RawResponse>;

export type LabelEvidenceOptions = {
  census: boolean;
  censusPages: number;
  sources: readonly EvidenceSource[];
};

export type LabelEvidenceDeps = {
  discogsToken?: string;
  http: EvidenceHttp;
  resolveLabel: (slugOrId: string) => Promise<LabelAdminItem>;
  scraper: BeatportScraper | null;
};

type MbArtistCredit = Array<{ artist?: { id?: string; name?: string }; name?: string }>;

type MbLabelPayload = {
  area?: { name?: string } | null;
  country?: null | string;
  disambiguation?: string;
  genres?: Array<{ name?: string }>;
  id?: string;
  "label-code"?: null | number;
  "life-span"?: { begin?: null | string; end?: null | string; ended?: boolean | null };
  name?: string;
  relations?: Array<{
    direction?: string;
    label?: { id?: string; name?: string };
    type?: string;
    url?: { resource?: string };
  }>;
  tags?: Array<{ name?: string }>;
  type?: null | string;
};

type MbReleasePayload = {
  "artist-credit"?: MbArtistCredit;
  barcode?: null | string;
  date?: string;
  id: string;
  "label-info"?: Array<{ "catalog-number"?: null | string; label?: { id?: string } | null }>;
  media?: Array<{
    format?: null | string;
    tracks?: Array<{
      "artist-credit"?: MbArtistCredit;
      recording?: { "artist-credit"?: MbArtistCredit; id?: string };
    }>;
  }>;
  status?: null | string;
  title?: string;
};

type MbReleaseBrowse = { "release-count"?: number; releases?: MbReleasePayload[] };

export function parseCensusPages(value: string): number {
  const pages = Number(value);

  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_CENSUS_PAGES) {
    throw new Error(`Pass --census-pages 1-${MAX_CENSUS_PAGES}`);
  }

  return pages;
}

export function parseEvidenceSources(value: string | undefined): EvidenceSource[] {
  if (value === undefined || value.trim() === "") {
    return [...EVIDENCE_SOURCES];
  }

  const wanted = value.split(",").map((entry) => entry.trim().toLowerCase());
  const unknown = wanted.filter(
    (entry) => !(EVIDENCE_SOURCES as readonly string[]).includes(entry),
  );

  if (unknown.length > 0) {
    throw new Error(
      `Unknown source(s): ${unknown.join(", ")} — pick from ${EVIDENCE_SOURCES.join(", ")}`,
    );
  }

  return EVIDENCE_SOURCES.filter((source) => wanted.includes(source));
}

function failureOf(error: unknown, request: string): SourceFailure {
  if (error instanceof EvidenceFetchError) {
    return {
      attempts: error.attempts,
      kind: error.kind,
      message: error.message,
      request,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }

  return {
    kind: "parse",
    message: error instanceof Error ? error.message : String(error),
    request,
  };
}

function statusFrom(parts: number, failures: number): SourceStatus {
  if (failures === 0) {
    return "ok";
  }

  return failures < parts ? "partial" : "error";
}

function tally(names: Iterable<string>): Count[] {
  const counts = new Map<string, number>();

  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function firstCredit(credit: MbArtistCredit | undefined): null | { mbid: string; name: string } {
  const head = credit?.[0];
  const mbid = head?.artist?.id;

  if (!mbid) {
    return null;
  }

  return { mbid, name: head?.artist?.name ?? head?.name ?? mbid };
}

function creditString(credit: MbArtistCredit | undefined): string {
  return (credit ?? []).map((entry) => entry.name ?? entry.artist?.name ?? "").join(" / ");
}

function linkOf(links: MbLabelFacts["links"], host: string): null | string {
  return links.find((link) => link.url.includes(host))?.url ?? null;
}

function toLabelFacts(payload: MbLabelPayload, mbid: string): MbLabelFacts {
  const relations = payload.relations ?? [];

  return {
    area: payload.area?.name ?? null,
    country: payload.country ?? null,
    disambiguation: payload.disambiguation || null,
    genres: (payload.genres ?? []).flatMap((genre) => (genre.name ? [genre.name] : [])),
    labelCode: payload["label-code"] ?? null,
    labelRelations: relations.flatMap((relation) =>
      relation.label?.id
        ? [
            {
              direction: relation.direction ?? "forward",
              mbid: relation.label.id,
              name: relation.label.name ?? relation.label.id,
              type: relation.type ?? "unknown",
            },
          ]
        : [],
    ),
    lifeSpan: {
      begin: payload["life-span"]?.begin ?? null,
      end: payload["life-span"]?.end ?? null,
      ended: payload["life-span"]?.ended === true,
    },
    links: relations.flatMap((relation) =>
      relation.url?.resource
        ? [{ type: relation.type ?? "unknown", url: relation.url.resource }]
        : [],
    ),
    mbid: payload.id ?? mbid,
    name: payload.name ?? mbid,
    tags: (payload.tags ?? []).flatMap((tag) => (tag.name ? [tag.name] : [])),
    type: payload.type ?? null,
  };
}

function toReleaseFacts(browse: MbReleaseBrowse, mbid: string): MbReleaseFacts {
  const releases = browse.releases ?? [];
  const byArtist = new Map<string, { mbid: string; name: string; releases: number }>();
  let variousArtistsReleases = 0;

  const samples = releases.map((release): MbReleaseSample => {
    const head = firstCredit(release["artist-credit"]);

    if (head?.mbid === VARIOUS_ARTISTS_MBID) {
      variousArtistsReleases += 1;
    } else if (head) {
      const entry = byArtist.get(head.mbid) ?? { mbid: head.mbid, name: head.name, releases: 0 };
      entry.releases += 1;
      byArtist.set(head.mbid, entry);
    }

    const info = release["label-info"]?.find((entry) => entry.label?.id === mbid);
    const formats = [
      ...new Set((release.media ?? []).flatMap((m) => (m.format ? [m.format] : []))),
    ];

    return {
      artist: creditString(release["artist-credit"]),
      barcode: release.barcode || null,
      catno: info?.["catalog-number"] ?? null,
      date: release.date || null,
      format: formats.length > 0 ? formats.join(" + ") : null,
      mbid: release.id,
      status: release.status ?? null,
      title: release.title ?? "",
    };
  });

  return {
    firstCreditArtists: [...byArtist.values()]
      .sort((a, b) => b.releases - a.releases || a.name.localeCompare(b.name))
      .slice(0, FIRST_CREDIT_ARTISTS),
    releaseCount: browse["release-count"] ?? releases.length,
    releases: samples
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, RELEASE_SAMPLE),
    releasesRead: releases.length,
    variousArtistsReleases,
  };
}

async function runCensus(
  deps: LabelEvidenceDeps,
  mbid: string,
  maxPages: number,
): Promise<{ cached: boolean; census: MbCensus }> {
  const credits = new Map<string, { artistMbid: string; artistName: string; recordings: number }>();
  const seen = new Set<string>();
  let offset = 0;
  let pagesFetched = 0;
  let releaseCount = 0;
  let allCached = true;

  while (pagesFetched < maxPages) {
    const url = `${MB_ROOT}/release?label=${mbid}&inc=artist-credits+recordings&limit=100&offset=${offset}&fmt=json`;
    const { cached, data } = await fetchEvidenceJson<MbReleaseBrowse>(
      deps.http,
      "musicbrainz",
      url,
    );
    const releases = data.releases ?? [];
    allCached &&= cached;
    pagesFetched += 1;
    releaseCount = data["release-count"] ?? releaseCount;

    for (const release of releases) {
      for (const medium of release.media ?? []) {
        for (const track of medium.tracks ?? []) {
          const recordingId = track.recording?.id;

          if (!recordingId || seen.has(recordingId)) {
            continue;
          }

          seen.add(recordingId);
          const head =
            firstCredit(track["artist-credit"]) ??
            firstCredit(track.recording?.["artist-credit"]) ??
            firstCredit(release["artist-credit"]);

          if (!head) {
            continue;
          }

          const entry = credits.get(head.mbid) ?? {
            artistMbid: head.mbid,
            artistName: head.name,
            recordings: 0,
          };
          entry.recordings += 1;
          credits.set(head.mbid, entry);
        }
      }
    }

    offset += releases.length;

    if (releases.length === 0 || offset >= releaseCount) {
      break;
    }
  }

  const sampled = offset < releaseCount;
  const firstCredits = [...credits.values()].sort(
    (a, b) => b.recordings - a.recordings || a.artistName.localeCompare(b.artistName),
  );

  return {
    cached: allCached,
    census: {
      caveat: sampled ? `sampled: first ${offset} of ${releaseCount} releases` : null,
      firstCredits,
      pagesFetched,
      recordingsCounted: firstCredits.reduce((sum, entry) => sum + entry.recordings, 0),
      releaseCount,
      releasesRead: offset,
      sampled,
    },
  };
}

async function gatherMusicBrainz(
  deps: LabelEvidenceDeps,
  mbid: string,
  options: LabelEvidenceOptions,
): Promise<SourceReport<MusicBrainzEvidence>> {
  const data: MusicBrainzEvidence = {};
  const errors: SourceFailure[] = [];
  let parts = 2;
  let allCached = true;

  const labelUrl = `${MB_ROOT}/label/${mbid}?inc=aliases+label-rels+url-rels+tags+genres&fmt=json`;
  try {
    const { cached, data: payload } = await fetchEvidenceJson<MbLabelPayload>(
      deps.http,
      "musicbrainz",
      labelUrl,
    );
    allCached &&= cached;
    data.label = toLabelFacts(payload, mbid);
  } catch (error) {
    errors.push(failureOf(error, labelUrl));
  }

  const releasesUrl = `${MB_ROOT}/release?label=${mbid}&inc=artist-credits+labels+media&limit=100&fmt=json`;
  try {
    const { cached, data: browse } = await fetchEvidenceJson<MbReleaseBrowse>(
      deps.http,
      "musicbrainz",
      releasesUrl,
    );
    allCached &&= cached;
    data.releases = toReleaseFacts(browse, mbid);
  } catch (error) {
    errors.push(failureOf(error, releasesUrl));
  }

  if (options.census) {
    parts += 1;
    try {
      const { cached, census } = await runCensus(deps, mbid, options.censusPages);
      allCached &&= cached;
      data.census = census;
    } catch (error) {
      errors.push(failureOf(error, `${MB_ROOT}/release?label=${mbid}&inc=recordings (census)`));
    }
  }

  return {
    cached: allCached,
    data,
    ...(errors.length > 0 ? { errors } : {}),
    status: statusFrom(parts, errors.length),
  };
}

type DiscogsLabelPayload = {
  id?: number;
  name?: string;
  parent_label?: { id?: number; name?: string } | null;
  profile?: string;
  sublabels?: Array<{ name?: string }>;
  uri?: string;
  urls?: string[];
};

type DiscogsReleasesPayload = {
  pagination?: { items?: number };
  releases?: Array<{
    artist?: string;
    catno?: string;
    format?: string;
    id?: number;
    main_release?: number;
    title?: string;
    type?: string;
    year?: number;
  }>;
};

type DiscogsReleasePayload = { genres?: string[]; styles?: string[] };

type DiscogsSearchPayload = {
  pagination?: { items?: number };
  results?: Array<{
    genre?: string[];
    id?: number;
    label?: string[];
    style?: string[];
    title?: string;
    uri?: string;
  }>;
};

export function discogsLabelIdFrom(url: null | string): null | number {
  const match = url ? /discogs\.com\/(?:[a-z]{2}\/)?label\/(\d+)/i.exec(url) : null;

  return match?.[1] ? Number(match[1]) : null;
}

export function beatportLabelUrlFrom(url: null | string): null | string {
  const match = url ? /beatport\.com\/label\/([^/?#]+)\/(\d+)/i.exec(url) : null;

  return match?.[1] && match[2] ? `https://www.beatport.com/label/${match[1]}/${match[2]}` : null;
}

function discogsHeaders(deps: LabelEvidenceDeps): Record<string, string> {
  return deps.discogsToken ? { Authorization: `Discogs token=${deps.discogsToken}` } : {};
}

async function discogsCandidates(
  deps: LabelEvidenceDeps,
  name: string,
): Promise<SourceReport<DiscogsEvidence>> {
  const searchUrl = `${DISCOGS_ROOT}/database/search?type=label&q=${encodeURIComponent(name)}&per_page=5`;

  try {
    const { cached, data } = await fetchEvidenceJson<DiscogsSearchPayload>(
      deps.http,
      "discogs",
      searchUrl,
      discogsHeaders(deps),
    );
    const candidates = (data.results ?? []).flatMap((result) =>
      result.id
        ? [
            {
              id: result.id,
              title: result.title ?? "",
              url: `https://www.discogs.com${result.uri ?? `/label/${result.id}`}`,
            },
          ]
        : [],
    );

    return {
      cached,
      data: { candidates },
      note: "The MusicBrainz label has no Discogs link. Candidates are unverified name matches: confirm the identity before citing any of them.",
      status: "no_link",
    };
  } catch (error) {
    return {
      errors: [failureOf(error, searchUrl)],
      note: "The MusicBrainz label has no Discogs link.",
      status: "no_link",
    };
  }
}

function toDiscogsLabel(
  payload: DiscogsLabelPayload,
  labelId: number,
  fallbackName: string,
): NonNullable<DiscogsEvidence["label"]> {
  const sublabels = (payload.sublabels ?? []).flatMap((entry) => (entry.name ? [entry.name] : []));
  const parent = payload.parent_label;

  return {
    id: payload.id ?? labelId,
    name: payload.name ?? fallbackName,
    parentLabel: parent?.id === undefined ? null : { id: parent.id, name: parent.name ?? "" },
    profile: (payload.profile ?? "").slice(0, PROFILE_CHARS),
    sublabelCount: sublabels.length,
    sublabels: sublabels.slice(0, 30),
    url: payload.uri ?? `https://www.discogs.com/label/${labelId}`,
    urls: payload.urls ?? [],
  };
}

function toDiscogsReleases(payload: DiscogsReleasesPayload): {
  facts: NonNullable<DiscogsEvidence["releases"]>;
  ids: number[];
} {
  const releases = payload.releases ?? [];
  const ids = releases.flatMap((release) => {
    const id = release.type === "master" ? release.main_release : release.id;

    return typeof id === "number" ? [id] : [];
  });

  return {
    facts: {
      releaseCount: payload.pagination?.items ?? releases.length,
      sample: releases.slice(0, DISCOGS_RELEASE_SAMPLE).map((release) => ({
        artist: release.artist ?? "",
        catno: release.catno ?? null,
        format: release.format ?? null,
        title: release.title ?? "",
        year: release.year || null,
      })),
      topArtists: tally(releases.map((release) => release.artist ?? ""))
        .filter((entry) => entry.name !== "")
        .slice(0, 15)
        .map((entry) => ({ name: entry.name, releases: entry.count })),
    },
    ids,
  };
}

async function gatherDiscogs(
  deps: LabelEvidenceDeps,
  mb: MusicBrainzEvidence,
): Promise<SourceReport<DiscogsEvidence>> {
  const labelFacts = mb.label;

  if (!labelFacts) {
    return {
      note: "MusicBrainz label unavailable, so no Discogs link to follow",
      status: "skipped",
    };
  }

  const labelId = discogsLabelIdFrom(linkOf(labelFacts.links, "discogs.com"));

  if (labelId === null) {
    return discogsCandidates(deps, labelFacts.name);
  }

  const headers = discogsHeaders(deps);
  const data: DiscogsEvidence = {};
  const errors: SourceFailure[] = [];
  const releaseIds = new Set<number>();
  let allCached = true;

  const labelUrl = `${DISCOGS_ROOT}/labels/${labelId}`;
  try {
    const { cached, data: payload } = await fetchEvidenceJson<DiscogsLabelPayload>(
      deps.http,
      "discogs",
      labelUrl,
      headers,
    );
    allCached &&= cached;
    data.label = toDiscogsLabel(payload, labelId, labelFacts.name);
  } catch (error) {
    errors.push(failureOf(error, labelUrl));
  }

  const releasesUrl = `${DISCOGS_ROOT}/labels/${labelId}/releases?per_page=100&page=1`;
  try {
    const { cached, data: payload } = await fetchEvidenceJson<DiscogsReleasesPayload>(
      deps.http,
      "discogs",
      releasesUrl,
      headers,
    );
    allCached &&= cached;
    const { facts, ids } = toDiscogsReleases(payload);
    data.releases = facts;
    for (const id of ids) {
      releaseIds.add(id);
    }
  } catch (error) {
    errors.push(failureOf(error, releasesUrl));
  }

  if (releaseIds.size > 0) {
    const styled = await readDiscogsStyles(deps, releaseIds, data.label?.name ?? labelFacts.name);
    allCached &&= styled.cached;
    errors.push(...styled.errors);
    data.styles = styled.styles;
  }

  return {
    cached: allCached,
    data,
    ...(errors.length > 0 ? { errors } : {}),
    status: discogsStatus(data, errors),
  };
}

function discogsStatus(data: DiscogsEvidence, errors: SourceFailure[]): SourceStatus {
  if (Object.keys(data).length === 0) {
    return "error";
  }

  return errors.length > 0 ? "partial" : "ok";
}

export function discogsSearchName(name: string): string {
  return name.replace(/\s*\(\d+\)$/, "").replace(/^[^\p{L}\p{N}]+/u, "");
}

async function readDiscogsStyles(
  deps: LabelEvidenceDeps,
  releaseIds: Set<number>,
  labelName: string,
): Promise<{
  cached: boolean;
  errors: SourceFailure[];
  styles: NonNullable<DiscogsEvidence["styles"]>;
}> {
  const headers = discogsHeaders(deps);
  const styled = new Map<number, { genres: string[]; styles: string[] }>();
  const errors: SourceFailure[] = [];
  let allCached = true;
  let viaSearch = 0;

  const searchUrl = `${DISCOGS_ROOT}/database/search?type=release&label=${encodeURIComponent(discogsSearchName(labelName))}&per_page=100`;
  try {
    const { cached, data } = await fetchEvidenceJson<DiscogsSearchPayload>(
      deps.http,
      "discogs",
      searchUrl,
      headers,
    );
    allCached &&= cached;

    for (const result of data.results ?? []) {
      if (typeof result.id === "number" && releaseIds.has(result.id) && !styled.has(result.id)) {
        styled.set(result.id, { genres: result.genre ?? [], styles: result.style ?? [] });
      }
    }

    viaSearch = styled.size;
  } catch (error) {
    errors.push(failureOf(error, searchUrl));
  }

  const target = Math.min(DISCOGS_STYLE_TARGET, releaseIds.size);
  const unread = [...releaseIds].filter((id) => !styled.has(id));
  let reads = 0;

  for (const id of unread) {
    if (styled.size >= target || reads >= DISCOGS_RELEASE_READS) {
      break;
    }

    reads += 1;
    const releaseUrl = `${DISCOGS_ROOT}/releases/${id}`;
    try {
      const { cached, data } = await fetchEvidenceJson<DiscogsReleasePayload>(
        deps.http,
        "discogs",
        releaseUrl,
        headers,
      );
      allCached &&= cached;
      styled.set(id, { genres: data.genres ?? [], styles: data.styles ?? [] });
    } catch (error) {
      errors.push(failureOf(error, releaseUrl));
    }
  }

  const rows = [...styled.values()];

  return {
    cached: allCached,
    errors,
    styles: {
      genres: tally(rows.flatMap((row) => row.genres)),
      labelReleasesListed: releaseIds.size,
      releasesRead: rows.length,
      styles: tally(rows.flatMap((row) => row.styles)).slice(0, 25),
      viaRelease: rows.length - viaSearch,
      viaSearch,
    },
  };
}

type BeatportFacetRow = { count?: number; name?: string };

type BeatportTracksQuery = {
  queryKey?: unknown[];
  state?: {
    data?: {
      count?: number;
      facets?: {
        fields?: {
          artists?: BeatportFacetRow[];
          genre?: BeatportFacetRow[];
          sub_genre?: BeatportFacetRow[];
        };
      };
    };
  };
};

function facetCounts(rows: BeatportFacetRow[] | undefined): Count[] {
  return (rows ?? [])
    .flatMap((row) =>
      row.name && typeof row.count === "number" ? [{ count: row.count, name: row.name }] : [],
    )
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function parseBeatportTracksPage(
  html: string,
): null | Omit<BeatportEvidence, "labelUrl" | "tracksUrl"> {
  const island = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);

  if (!island?.[1]) {
    return null;
  }

  let queries: BeatportTracksQuery[];
  try {
    const parsed = JSON.parse(island[1]) as {
      props?: { pageProps?: { dehydratedState?: { queries?: BeatportTracksQuery[] } } };
    };
    queries = parsed.props?.pageProps?.dehydratedState?.queries ?? [];
  } catch {
    return null;
  }

  const tracks = queries.find(
    (query) => query.queryKey?.[0] === "tracks" && query.state?.data?.facets?.fields,
  )?.state?.data;

  if (!tracks) {
    return null;
  }

  const fields = tracks.facets?.fields;
  const genres = facetCounts(fields?.genre);
  const total = genres.reduce((sum, genre) => sum + genre.count, 0);

  return {
    genres: genres.map((genre) => ({
      ...genre,
      share: total > 0 ? Math.round((genre.count / total) * 1000) / 1000 : 0,
    })),
    subGenres: facetCounts(fields?.sub_genre),
    topArtists: facetCounts(fields?.artists).slice(0, 15),
    trackCount: tracks.count ?? total,
  };
}

async function gatherBeatport(
  deps: LabelEvidenceDeps,
  mb: MusicBrainzEvidence,
): Promise<SourceReport<BeatportEvidence>> {
  if (!mb.label) {
    return {
      note: "MusicBrainz label unavailable, so no Beatport link to follow",
      status: "skipped",
    };
  }

  const labelUrl = beatportLabelUrlFrom(linkOf(mb.label.links, "beatport.com"));

  if (labelUrl === null) {
    return { note: "The MusicBrainz label has no Beatport link.", status: "no_link" };
  }

  if (deps.scraper === null) {
    return {
      note: "Beatport needs Firecrawl: set FIRECRAWL_API_KEY or install the firecrawl CLI.",
      status: "not_configured",
    };
  }

  const scraper = deps.scraper;
  const tracksUrl = `${labelUrl}/tracks`;
  try {
    const { cached, text } = await fetchEvidenceText(
      deps.http,
      "beatport",
      `SCRAPE ${tracksUrl}`,
      (signal) => scraper(tracksUrl, signal),
    );
    const facts = parseBeatportTracksPage(text);

    if (facts === null) {
      return {
        errors: [
          {
            kind: "parse",
            message:
              "The Beatport page carried no tracks facet (a missing label or a layout change)",
            request: tracksUrl,
          },
        ],
        status: "error",
      };
    }

    return { cached, data: { ...facts, labelUrl, tracksUrl }, status: "ok" };
  } catch (error) {
    return { errors: [failureOf(error, tracksUrl)], status: "error" };
  }
}

type AppleLookupPayload = {
  results?: Array<{
    artistName?: string;
    collectionName?: string;
    copyright?: string;
    primaryGenreName?: string;
    wrapperType?: string;
  }>;
};

async function gatherApple(
  deps: LabelEvidenceDeps,
  mb: MusicBrainzEvidence,
): Promise<SourceReport<AppleEvidence>> {
  if (!mb.releases) {
    return {
      note: "MusicBrainz releases unavailable, so no barcodes to look up",
      status: "skipped",
    };
  }

  const seen = new Set<string>();
  const targets = mb.releases.releases.filter((release) => {
    if (!release.barcode || seen.has(release.barcode)) {
      return false;
    }

    seen.add(release.barcode);

    return true;
  });

  if (targets.length === 0) {
    return { note: "No sampled MusicBrainz release carries a barcode.", status: "no_link" };
  }

  const releases: AppleEvidence["releases"] = [];
  const errors: SourceFailure[] = [];
  let allCached = true;

  for (const target of targets.slice(0, APPLE_LOOKUPS)) {
    const barcode = target.barcode ?? "";
    const url = `https://itunes.apple.com/lookup?upc=${encodeURIComponent(barcode)}&entity=album`;
    try {
      const { cached, data } = await fetchEvidenceJson<AppleLookupPayload>(deps.http, "apple", url);
      allCached &&= cached;
      const hit = (data.results ?? []).find((result) => result.wrapperType === "collection");
      releases.push(
        hit
          ? {
              artistName: hit.artistName,
              barcode,
              collectionName: hit.collectionName,
              copyright: hit.copyright,
              found: true,
              mbTitle: target.title,
              primaryGenreName: hit.primaryGenreName,
            }
          : { barcode, found: false, mbTitle: target.title },
      );
    } catch (error) {
      errors.push(failureOf(error, url));
    }
  }

  const looked = Math.min(targets.length, APPLE_LOOKUPS);

  return {
    cached: allCached,
    data: {
      found: releases.filter((release) => release.found).length,
      genres: tally(releases.flatMap((release) => release.primaryGenreName ?? [])),
      looked,
      releases,
    },
    ...(errors.length > 0 ? { errors } : {}),
    status: statusFrom(looked, errors.length),
  };
}

function skipped<T>(): SourceReport<T> {
  return { note: "Not requested (--sources).", status: "skipped" };
}

async function resolveTarget(
  input: string,
  deps: LabelEvidenceDeps,
): Promise<LabelEvidence["label"]> {
  const trimmed = input.trim();

  if (MBID_PATTERN.test(trimmed)) {
    return { input: trimmed, mbLabelId: trimmed.toLowerCase() };
  }

  const label = await deps.resolveLabel(trimmed);

  if (!label.mbLabelId) {
    throw new Error(
      `Label '${label.slug}' has no MusicBrainz identity (mb_label_id), so nothing says which same-named label to research. Resolve it by hand first (docs/label-entity.md).`,
    );
  }

  return {
    id: label.id,
    input: trimmed,
    mbLabelId: label.mbLabelId.toLowerCase(),
    name: label.name,
    seedState: label.seedState,
    slug: label.slug,
  };
}

export async function gatherLabelEvidence(
  input: string,
  options: LabelEvidenceOptions,
  deps: LabelEvidenceDeps,
): Promise<LabelEvidence> {
  const label = await resolveTarget(input, deps);
  const wants = (source: EvidenceSource) => options.sources.includes(source);
  const needsMb = wants("musicbrainz") || wants("discogs") || wants("beatport") || wants("apple");
  const musicbrainz = needsMb
    ? await gatherMusicBrainz(deps, label.mbLabelId, options)
    : skipped<MusicBrainzEvidence>();
  const mb = musicbrainz.data ?? {};

  const [discogs, beatport, apple] = await Promise.all([
    wants("discogs") ? gatherDiscogs(deps, mb) : Promise.resolve(skipped<DiscogsEvidence>()),
    wants("beatport") ? gatherBeatport(deps, mb) : Promise.resolve(skipped<BeatportEvidence>()),
    wants("apple") ? gatherApple(deps, mb) : Promise.resolve(skipped<AppleEvidence>()),
  ]);

  const sources = { apple, beatport, discogs, musicbrainz };
  const reports = Object.entries(sources) as Array<[EvidenceSource, SourceReport<unknown>]>;
  const errors = reports.flatMap(([source, report]) =>
    (report.errors ?? []).map((failure) => ({ ...failure, source })),
  );
  const requested = reports.filter(([source]) => wants(source));
  const answered = requested.filter(([, report]) =>
    ["no_link", "ok", "partial"].includes(report.status),
  );

  return {
    errors,
    fetchedAt: new Date(deps.http.now()).toISOString(),
    label: { ...label, name: label.name ?? mb.label?.name },
    ok: answered.length > 0,
    partial: answered.length < requested.length || errors.length > 0,
    requests: { cacheHits: deps.http.stats.cacheHits, network: deps.http.stats.requests },
    sources,
  };
}

export function firecrawlApiScraper(apiKey: string, http: EvidenceHttp): BeatportScraper {
  return async (url, signal) => {
    const response = await http.fetch(FIRECRAWL_SCRAPE_URL, {
      body: JSON.stringify({ formats: ["rawHtml"], url }),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal,
    });

    if (!response.ok) {
      return { headers: response.headers, status: response.status, text: await response.text() };
    }

    const payload = (await response.json()) as {
      data?: { metadata?: { statusCode?: number }; rawHtml?: string };
    };

    return {
      headers: response.headers,
      status: payload.data?.metadata?.statusCode ?? 200,
      text: payload.data?.rawHtml ?? "",
    };
  };
}

export function firecrawlCliScraper(binary: string): BeatportScraper {
  return (url, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, ["scrape", "-f", "rawHtml", url], {
        signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve({
            headers: { get: () => null },
            status: 200,
            text: Buffer.concat(out).toString("utf8"),
          });
          return;
        }

        const tail = Buffer.concat(err).toString("utf8").trim().split("\n").slice(-2).join(" ");
        reject(new Error(`firecrawl CLI exited ${code}: ${tail}`));
      });
    });
}

export function defaultBeatportScraper(
  env: { firecrawlApiKey?: string; firecrawlBinary?: null | string },
  http: EvidenceHttp,
): BeatportScraper | null {
  if (env.firecrawlApiKey) {
    return firecrawlApiScraper(env.firecrawlApiKey, http);
  }

  return env.firecrawlBinary ? firecrawlCliScraper(env.firecrawlBinary) : null;
}

export async function labelEvidenceCommand(
  input: string,
  options: LabelEvidenceOptions & { refresh: boolean },
): Promise<LabelEvidence> {
  const [{ readOptionalEnv }, { resolveLabel }] = await Promise.all([
    import("../env"),
    import("./admin-labels"),
  ]);
  const http = createEvidenceHttp({ refresh: options.refresh });
  const discogsToken = readOptionalEnv("DISCOGS_USER_TOKEN");

  if (discogsToken) {
    http.policies = { ...http.policies, discogs: { ...http.policies.discogs, intervalMs: 1_100 } };
  }

  return gatherLabelEvidence(input, options, {
    discogsToken,
    http,
    resolveLabel,
    scraper: defaultBeatportScraper(
      {
        firecrawlApiKey: readOptionalEnv("FIRECRAWL_API_KEY"),
        firecrawlBinary: Bun.which("firecrawl"),
      },
      http,
    ),
  });
}

function countLine(counts: Count[], limit: number): string {
  return counts
    .slice(0, limit)
    .map((entry) => `${entry.name} ${entry.count}`)
    .join(", ");
}

export function labelEvidenceLines(evidence: LabelEvidence): string[] {
  const { apple, beatport, discogs, musicbrainz } = evidence.sources;
  const mb = musicbrainz.data;
  const name = evidence.label.name ?? evidence.label.mbLabelId;
  const lines = [`${name} (${evidence.label.mbLabelId})`];

  const mbParts: string[] = [];
  if (mb?.label) {
    mbParts.push(
      [mb.label.type, mb.label.area, mb.label.lifeSpan.begin].filter(Boolean).join(", "),
    );
  }
  if (mb?.releases) {
    const top = mb.releases.firstCreditArtists
      .slice(0, 6)
      .map((artist) => `${artist.name} ${artist.releases}`)
      .join(", ");
    mbParts.push(`${mb.releases.releaseCount} releases; first credits: ${top || "none"}`);
  }
  if (mb?.census) {
    mbParts.push(
      `census ${mb.census.recordingsCounted} recordings over ${mb.census.releasesRead} releases${mb.census.caveat ? ` (${mb.census.caveat})` : ""}`,
    );
  }
  lines.push(
    `  musicbrainz: ${musicbrainz.status}${mbParts.length ? ` — ${mbParts.join("; ")}` : ""}`,
  );

  const dg = discogs.data;
  const dgDetail = dg?.styles
    ? `styles: ${countLine(dg.styles.styles, 6)} (${dg.styles.releasesRead} releases)`
    : dg?.candidates
      ? `unverified candidates: ${dg.candidates.map((c) => c.title).join(", ") || "none"}`
      : discogs.note;
  lines.push(`  discogs: ${discogs.status}${dgDetail ? ` — ${dgDetail}` : ""}`);

  const bp = beatport.data;
  const bpDetail = bp
    ? `${bp.trackCount} tracks; genres: ${bp.genres
        .slice(0, 5)
        .map((genre) => `${genre.name} ${Math.round(genre.share * 100)}%`)
        .join(", ")}`
    : beatport.note;
  lines.push(`  beatport: ${beatport.status}${bpDetail ? ` — ${bpDetail}` : ""}`);

  const ap = apple.data;
  const apDetail = ap
    ? `${ap.found}/${ap.looked} found; genres: ${countLine(ap.genres, 4) || "none"}`
    : apple.note;
  lines.push(`  apple: ${apple.status}${apDetail ? ` — ${apDetail}` : ""}`);

  for (const failure of evidence.errors) {
    lines.push(`  ! ${failure.source}: ${failure.message}`);
  }

  return lines;
}

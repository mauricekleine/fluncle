// The resolvers behind the three held discovery concepts.
//
// Each concept route reaches this module by a DYNAMIC import inside its
// `createServerFn().handler()` body and takes its types by `import type`, so no
// concept route statically references the snapshot — the `-*-page-data.ts`
// pattern the artist, album, label, and identity pages already use
// (docs/client-bundle.md).
//
// The three resolvers answer three different QUESTIONS, which is the point of the
// exhibit: `resolveFront*` answers "what should I read", `resolveDesk` answers
// "what matches", `resolveRun` answers "what is next". The row shape they hand
// back is identical, so the comparison is about the model and never about the
// data.

import {
  type ConceptEntity,
  type ConceptEntityKind,
  type ConceptEntityPage,
  type ConceptTrack,
  type SonicNeighbourhood,
  type CaptureMeta,
  type TempoBandId,
  TEMPO_BANDS,
  tempoBandOf,
} from "@/concepts/discovery/model";
import {
  CAPTURE,
  FRESH_WINDOW_DAYS,
  allCatalogue,
  allFindings,
  conceptEntities,
  entityPage,
  findingByLogId,
  freshRecords,
  freshTracks,
  nearestAnchor,
  neighbourhoodOf,
  sonicAnchorLogIds,
  type FreshRecord,
} from "@/concepts/discovery/source";

export type { FreshRecord };

/* ── shared ───────────────────────────────────────────────────────────────── */

export type ConceptExhibit = {
  capture: CaptureMeta;
  entities: ConceptEntity[];
};

export function resolveExhibit(): ConceptExhibit {
  return { capture: CAPTURE, entities: conceptEntities() };
}

/* ── concept A: the front page ────────────────────────────────────────────── */

/**
 * An edited front page. Placement is the product: the lead is the newest finding
 * that can carry a full-bleed cover and a note, the column under it is the rest of
 * the week's certifications in found order, and the release rail beside them is
 * the broad archive utility — what came out, whether or not Fluncle has been there.
 */
export type FrontPageData = {
  capture: CaptureMeta;
  lead: ConceptTrack;
  /** The week's other certifications, in found order. */
  column: ConceptTrack[];
  /** Older certifications, still edited but no longer the top of the page. */
  archive: ConceptTrack[];
  records: FreshRecord[];
  /** What came out lately, regardless of certification. */
  releases: ConceptTrack[];
  /** The window that release band actually covers, in days. */
  releaseWindowDays: number;
};

const FRONT_COLUMN = 6;
const FRONT_ARCHIVE = 12;
const FRONT_RELEASES = 10;

export function resolveFrontPage(): FrontPageData {
  const findings = allFindings();
  // The lead has to hold a full-bleed cover and a sentence; the first finding that
  // carries both leads, rather than whichever one happens to be newest.
  const leadIndex = findings.findIndex(
    (finding) => finding.coverUrl !== undefined && finding.note !== undefined,
  );
  const index = leadIndex === -1 ? 0 : leadIndex;
  const lead = findings[index];

  if (lead === undefined) {
    throw new Error("The capture holds no findings");
  }

  const rest = findings.filter((_, position) => position !== index);

  return {
    archive: rest.slice(FRONT_COLUMN, FRONT_COLUMN + FRONT_ARCHIVE),
    capture: CAPTURE,
    column: rest.slice(0, FRONT_COLUMN),
    lead,
    records: freshRecords().slice(0, 6),
    releaseWindowDays: FRESH_WINDOW_DAYS,
    releases: freshTracks().slice(0, FRONT_RELEASES),
  };
}

export type FrontFindingData =
  | {
      status: "found";
      finding: ConceptTrack;
      neighbourhood?: SonicNeighbourhood;
      /** Other certifications on the same imprint — the editorial sidebar. */
      sameLabel: ConceptTrack[];
    }
  | { status: "missing" };

export function resolveFrontFinding(logId: string): FrontFindingData {
  const finding = findingByLogId(logId);

  if (finding === undefined) {
    return { status: "missing" };
  }

  return {
    finding,
    neighbourhood: neighbourhoodOf(logId) ?? nearestAnchor(finding),
    sameLabel: allFindings()
      .filter((row) => row.label !== undefined && row.label === finding.label)
      .filter((row) => row.logId !== finding.logId)
      .slice(0, 4),
    status: "found",
  };
}

export type FrontEntityData = { status: "found"; page: ConceptEntityPage } | { status: "missing" };

export function resolveFrontEntity(kind: ConceptEntityKind, slug: string): FrontEntityData {
  const page = entityPage(kind, slug);

  return page === undefined ? { status: "missing" } : { page, status: "found" };
}

/* ── concept B: the desk ──────────────────────────────────────────────────── */

export type DeskFilters = {
  /** An exact act name; a direct arrival on `/artist/<slug>` lands here. */
  artist?: string;
  key?: string;
  label?: string;
  /** A coordinate whose captured sonic ranking becomes the candidate set. */
  soundsLike?: string;
  tempo?: TempoBandId;
  /** `lit` narrows to Fluncle's certifications; absent means everything. */
  tier?: "lit";
  q?: string;
};

export type DeskFacet = { count: number; label: string; value: string };

export type DeskData = {
  capture: CaptureMeta;
  /** Present only while a sonic facet is applied; it names what the order means. */
  anchor?: ConceptTrack;
  facets: {
    keys: DeskFacet[];
    labels: DeskFacet[];
    tempos: DeskFacet[];
  };
  filters: DeskFilters;
  /** The graph node a direct arrival named, when a filter resolves to one. */
  entity?: ConceptEntity;
  /** Coordinates the capture can actually rank against, offered as sonic seeds. */
  sonicSeeds: ConceptTrack[];
  /** True when the sonic facet decides the order rather than the release date. */
  sortedBySound: boolean;
  rows: ConceptTrack[];
  total: number;
};

const DESK_ROWS = 60;
const DESK_LABEL_FACETS = 10;
const DESK_KEY_FACETS = 8;

function deskCorpus(filters: DeskFilters): { anchor?: ConceptTrack; rows: ConceptTrack[] } {
  if (filters.soundsLike === undefined) {
    return { rows: [...allFindings(), ...allCatalogue()] };
  }

  const hood = neighbourhoodOf(filters.soundsLike);

  // A seed the capture cannot rank against declines rather than pretending: the
  // desk falls back to the whole corpus and says so by dropping the anchor.
  return hood === undefined
    ? { rows: [...allFindings(), ...allCatalogue()] }
    : { anchor: hood.anchor, rows: hood.neighbours };
}

function matchesQuery(track: ConceptTrack, q: string): boolean {
  const needle = q.trim().toLowerCase();

  if (needle === "") {
    return true;
  }

  return [track.title, track.album, track.label, ...track.artists]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.toLowerCase().includes(needle));
}

function passes(track: ConceptTrack, filters: DeskFilters, except?: keyof DeskFilters): boolean {
  if (
    except !== "tempo" &&
    filters.tempo !== undefined &&
    tempoBandOf(track.bpm) !== filters.tempo
  ) {
    return false;
  }

  if (
    except !== "artist" &&
    filters.artist !== undefined &&
    !track.artists.some((name) => name.toLowerCase() === filters.artist?.toLowerCase())
  ) {
    return false;
  }

  if (except !== "key" && filters.key !== undefined && track.key !== filters.key) {
    return false;
  }

  if (except !== "label" && filters.label !== undefined && track.label !== filters.label) {
    return false;
  }

  if (except !== "tier" && filters.tier === "lit" && !track.certified) {
    return false;
  }

  if (except !== "q" && filters.q !== undefined && !matchesQuery(track, filters.q)) {
    return false;
  }

  return true;
}

function countBy(
  rows: ConceptTrack[],
  read: (track: ConceptTrack) => string | undefined,
  limit: number,
): DeskFacet[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const value = read(row);

    if (value !== undefined) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ count, label: value, value }));
}

export function resolveDesk(filters: DeskFilters): DeskData {
  const { anchor, rows: corpus } = deskCorpus(filters);
  const rows = corpus.filter((row) => passes(row, filters));
  // A sonic facet hands back a real cosine ranking, so the corpus order IS the
  // answer and nothing may re-sort it.
  //
  // Without one, certification leads and release date breaks the tie — the same
  // CERTIFIED_FIRST order the product's own archive search runs (`lib/server/
  // search.ts`). Release date alone put all 144 crawled forthcoming rows above
  // every finding, so the board opened with no lit row on it at all: the register
  // rides the light, and a board with no light on it carries no register.
  const sortedBySound = anchor !== undefined;
  const ordered = sortedBySound
    ? rows
    : [...rows].sort(
        (a, b) =>
          Number(b.certified) - Number(a.certified) ||
          (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""),
      );

  // A direct arrival names a graph node by its filter, so the desk can head the
  // board with who it is rather than with a bare predicate.
  const named = filters.artist ?? filters.label;
  const entity =
    named === undefined
      ? undefined
      : conceptEntities().find((candidate) => candidate.name.toLowerCase() === named.toLowerCase());

  return {
    anchor,
    capture: CAPTURE,
    entity,
    facets: {
      keys: countBy(
        corpus.filter((row) => passes(row, filters, "key")),
        (row) => row.key,
        DESK_KEY_FACETS,
      ),
      labels: countBy(
        corpus.filter((row) => passes(row, filters, "label")),
        (row) => row.label,
        DESK_LABEL_FACETS,
      ),
      tempos: TEMPO_BANDS.map((band) => ({
        count: corpus
          .filter((row) => passes(row, filters, "tempo"))
          .filter((row) => tempoBandOf(row.bpm) === band.id).length,
        label: band.label,
        value: band.id,
      })),
    },
    filters,
    rows: ordered.slice(0, DESK_ROWS),
    sonicSeeds: sonicAnchorLogIds()
      .map((logId) => findingByLogId(logId))
      .filter((track): track is ConceptTrack => track !== undefined),
    sortedBySound,
    total: ordered.length,
  };
}

/* ── concept C: the run ───────────────────────────────────────────────────── */

export type RunBranchKind = "label" | "next" | "sound";

export type RunBranch = {
  kind: RunBranchKind;
  /** The plain-language promise this branch keeps. */
  label: string;
  to: RunStop;
  track: ConceptTrack;
};

export type RunStop = { anchor?: string; entity?: string; step: number };

export type RunData = {
  branches: RunBranch[];
  capture: CaptureMeta;
  /** The stop the lane is holding on. */
  current: ConceptTrack;
  /** The stops already travelled, oldest first. */
  trail: ConceptTrack[];
  /** Named when the lane was entered from a graph node rather than cold. */
  entered?: ConceptEntity;
  stop: RunStop;
};

const RUN_TRAIL = 4;

function runLane(entity: string | undefined): ConceptTrack[] {
  if (entity === undefined) {
    return allFindings();
  }

  const [kind, slug] = entity.split(":");
  const page =
    kind === "album" || kind === "artist" || kind === "label"
      ? entityPage(kind, slug ?? "")
      : undefined;

  // An entity with nothing certified still opens the lane — on what Fluncle holds
  // there rather than on nothing.
  const rows = page === undefined ? [] : [...page.findings, ...page.catalogue];

  return rows.length === 0 ? allFindings() : rows;
}

export function resolveRun(stop: RunStop): RunData {
  const anchored = stop.anchor === undefined ? undefined : neighbourhoodOf(stop.anchor);
  // The lane a step indexes into is the SONIC ranking when one is anchored and the
  // entity's own rows otherwise. Clamping against the other one would land a stop
  // outside its own trail: a coherent-looking screen whose parts are unrelated.
  const trailSource = anchored === undefined ? runLane(stop.entity) : anchored.neighbours;
  const step = Math.max(0, Math.min(stop.step, trailSource.length - 1));
  const current = trailSource[step];

  if (current === undefined) {
    throw new Error("The capture holds no lane to run");
  }

  const hood = anchored ?? nearestAnchor(current);
  const [kind, slug] = (stop.entity ?? "").split(":");
  const enteredPage =
    kind === "album" || kind === "artist" || kind === "label"
      ? entityPage(kind, slug ?? "")
      : undefined;

  const branches: RunBranch[] = [];
  const nextInLane = trailSource[step + 1];

  if (nextInLane !== undefined) {
    branches.push({
      kind: "next",
      label: "Keep going",
      to: { anchor: stop.anchor, entity: stop.entity, step: step + 1 },
      track: nextInLane,
    });
  }

  // The sound branch is the one that leaves the lane: it re-anchors on the track
  // playing now and steps into Fluncle's own ranking around it.
  const sonicStep = hood?.neighbours[0];

  if (hood !== undefined && sonicStep !== undefined && hood.anchor.logId !== stop.anchor) {
    branches.push({
      kind: "sound",
      label: "Close in sound",
      to: { anchor: hood.anchor.logId, step: 0 },
      track: sonicStep,
    });
  }

  const labelStep = allFindings().find(
    (row) => row.label !== undefined && row.label === current.label && row.logId !== current.logId,
  );
  const labelStop: RunStop = { entity: `label:${labelStep?.labelSlug ?? ""}`, step: 0 };
  // A branch that leads back to the stop already showing is not a branch. Standing
  // on a label's own lane, the imprint step has nowhere new to go, so it is dropped
  // here rather than rendered as a control that does nothing.
  const labelIsHere = labelStop.entity === stop.entity && step === 0;

  if (labelStep?.labelSlug !== undefined && current.label !== undefined && !labelIsHere) {
    branches.push({
      kind: "label",
      label: `More from ${current.label}`,
      to: labelStop,
      track: labelStep,
    });
  }

  return {
    branches,
    capture: CAPTURE,
    current,
    entered: enteredPage?.entity,
    stop: { anchor: stop.anchor, entity: stop.entity, step },
    trail: trailSource.slice(Math.max(0, step - RUN_TRAIL), step),
  };
}

import { type Client } from "@libsql/client";
import { type DiscogsLabelCandidate, type DiscogsLabelWork } from "@fluncle/contracts/orpc";
import {
  type DiscogsLabelImage,
  fetchDiscogsLabelImage,
  parseDiscogsLabelUrl,
  verifyDiscogsLabelEvidence,
} from "./discogs";
import { getDb, typedRows } from "./db";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import { readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { MB_USER_AGENT, mbFetch } from "./musicbrainz";

const MAX_BATCH = 4;

const COOLDOWN_MS = 6 * 60 * 60 * 1000;

const LABEL_LOGO_CACHE_CONTROL = "public, max-age=604800, immutable";

const MAX_LABEL_IMAGE_BYTES = 5_000_000;

const MIME_EXTENSION: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

function extensionForMime(mime: string): string {
  return MIME_EXTENSION[mime] ?? "img";
}

function labelLogoKey(slug: string, mime: string): string {
  return `labels/${slug}.${extensionForMime(mime)}`;
}

type ResolveOutcome =
  | { kind: "discogs-work"; discogsLabelId: number }
  | { kind: "resolved"; imageKey: string; source: "discogs" | "wikidata" }
  | { kind: "none" }
  | { kind: "failed"; error: string }
  | { kind: "rate-limited" };

export type LabelImagesResolveResult = {
  discogsWork: DiscogsLabelWork[];
  dryRun: boolean;

  resolved: string[];
  resolvedCount: number;

  none: string[];
  noneCount: number;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;

  nextCursor: string | null;

  rateLimited: boolean;
};

type MbLabelSearchResponse = { labels?: { id?: string; name?: string; score?: number }[] };
type MbUrlRel = { type?: string; url?: { resource?: string } };
type MbLabelDetail = { id?: string; relations?: MbUrlRel[]; error?: unknown };

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export async function searchMbLabelId(
  name: string,
): Promise<{ mbid: string | null; rateLimited: boolean }> {
  const { data, rateLimited } = await mbFetch<MbLabelSearchResponse>(
    `/label?query=${encodeURIComponent(name)}&limit=5`,
  );

  if (rateLimited) {
    return { mbid: null, rateLimited: true };
  }

  const want = fold(name);
  const match = (data?.labels ?? []).find(
    (candidate) => candidate.id && candidate.name && fold(candidate.name) === want,
  );

  return { mbid: match?.id ?? null, rateLimited: false };
}

async function walkMbLabelRels(
  mbid: string,
): Promise<{ discogsLabelId: number | null; wikidataQid: string | null; rateLimited: boolean }> {
  const { data, rateLimited } = await mbFetch<MbLabelDetail>(
    `/label/${encodeURIComponent(mbid)}?inc=url-rels`,
  );

  if (rateLimited) {
    return { discogsLabelId: null, rateLimited: true, wikidataQid: null };
  }

  let discogsLabelId: number | null = null;
  let wikidataQid: string | null = null;

  for (const relation of data?.relations ?? []) {
    const resource = relation.url?.resource;

    if (!resource) {
      continue;
    }

    if (discogsLabelId === null) {
      const id = parseDiscogsLabelUrl(resource);

      if (id !== undefined) {
        discogsLabelId = id;
        continue;
      }
    }

    if (wikidataQid === null) {
      const match = resource.match(/wikidata\.org\/(?:wiki|entity)\/(Q\d+)/i);

      if (match?.[1]) {
        wikidataQid = match[1];
      }
    }
  }

  return { discogsLabelId, rateLimited: false, wikidataQid };
}

type WikidataEntityData = {
  entities?: Record<
    string,
    { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>> }
  >;
};

type WikidataImageOutcome =
  | { kind: "failed"; error: string }
  | { kind: "image"; image: DiscogsLabelImage }
  | { kind: "none" }
  | { kind: "rate-limited" };

function failedHttpOutcome(source: string, response: Response): WikidataImageOutcome {
  if (response.status === 429 || response.status === 503) {
    return { kind: "rate-limited" };
  }

  if (response.status === 404 || response.status === 410) {
    return { kind: "none" };
  }

  return {
    error: `${source} failed (${response.status} ${response.statusText || "unknown"})`,
    kind: "failed",
  };
}

async function downloadImage(
  url: string,
  headers: Record<string, string>,
): Promise<WikidataImageOutcome> {
  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return failedHttpOutcome("Wikimedia image request", response);
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.startsWith("image/")) {
      return { kind: "none" };
    }

    const bytes = await response.arrayBuffer();

    if (bytes.byteLength === 0) {
      return { error: "Wikimedia image response was empty", kind: "failed" };
    }

    if (bytes.byteLength > MAX_LABEL_IMAGE_BYTES) {
      return { kind: "none" };
    }

    return {
      image: { bytes, mime: contentType.split(";")[0]?.trim() || "image/jpeg" },
      kind: "image",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      kind: "failed",
    };
  }
}

async function fetchWikidataLogoImage(qid: string): Promise<WikidataImageOutcome> {
  try {
    const response = await fetch(
      `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`,
      { headers: { "User-Agent": MB_USER_AGENT } },
    );

    if (!response.ok) {
      return failedHttpOutcome("Wikidata entity request", response);
    }

    const data = (await response.json()) as WikidataEntityData;
    const filename = data.entities?.[qid]?.claims?.P154?.[0]?.mainsnak?.datavalue?.value;

    if (typeof filename !== "string" || !filename.trim()) {
      return { kind: "none" };
    }

    const commonsUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(
      filename,
    )}?width=600`;

    return await downloadImage(commonsUrl, { "User-Agent": MB_USER_AGENT });
  } catch (error) {
    logEvent("warn", "label-images.wikidata-failed", { error, qid });

    return {
      error: error instanceof Error ? error.message : String(error),
      kind: "failed",
    };
  }
}

type LabelWorkRow = {
  discogs_label_id: number | null;
  image_failures: number;
  mb_label_id: string | null;
  name: string;
  slug: string;
};

function labelImageContinuation(
  cursor: string | undefined,
): { sortKey: string; subjectId: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  return {
    sortKey: encodeDueWorkOrder([{ direction: "asc", kind: "text", value: cursor }]),
    subjectId: cursor,
  };
}

function restoreLabelImageOrder(
  rows: LabelWorkRow[],
  subjectIds: readonly string[],
): LabelWorkRow[] {
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  return subjectIds.flatMap((slug) => {
    const row = bySlug.get(slug);
    return row === undefined ? [] : [row];
  });
}

async function listProjectedLabels(
  limit: number,
  cursor: string | undefined,
  slugs?: string[],
): Promise<LabelWorkRow[]> {
  if (slugs?.length === 0) {
    return [];
  }

  const db = await getDb();
  const page = await readPromotedDueWorkPage(db, "label.image", {
    ...(cursor === undefined ? {} : { continuation: labelImageContinuation(cursor) }),
    limit,
    ...(slugs === undefined ? {} : { subjectIds: slugs }),
  });

  if (page.subjectIds.length === 0) {
    return [];
  }

  const placeholders = page.subjectIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: page.subjectIds,
    sql: `select slug, name, mb_label_id, discogs_label_id, image_failures
          from labels
          where slug in (${placeholders})`,
  });

  return restoreLabelImageOrder(typedRows<LabelWorkRow>(result.rows), page.subjectIds);
}

async function listPendingLabels(
  limit: number,
  cursor: string | undefined,
  slugs?: string[],
): Promise<LabelWorkRow[]> {
  if (slugs?.length === 0) {
    return [];
  }

  const db = await getDb();
  const cooldownBefore = new Date(Date.now() - COOLDOWN_MS).toISOString();
  const slugFilter = slugs ? `and slug in (${slugs.map(() => "?").join(", ")})` : "";
  const cursorFilter = cursor ? "and slug > ?" : "";

  const result = await db.execute({
    args: [cooldownBefore, ...(slugs ?? []), ...(cursor ? [cursor] : []), limit],
    sql: `select slug, name, mb_label_id, discogs_label_id, image_failures
         from labels
         where image_state = 'pending'
           and (image_attempted_at is null or image_attempted_at < ?)
           ${slugFilter}
           ${cursorFilter}
         order by slug asc limit ?`,
  });

  return typedRows<LabelWorkRow>(result.rows);
}

async function persistLabelMbLabelIdInternal(
  slug: string,
  mbLabelId: string,
  client?: Pick<Client, "execute">,
): Promise<void> {
  const db = client ?? (await getDb());

  await db.execute({
    args: [mbLabelId, slug],
    sql: `update labels set mb_label_id = ? where slug = ? and mb_label_id is null`,
  });
}

async function persistDiscogsLabelId(slug: string, discogsLabelId: number): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [discogsLabelId, slug],
    sql: `update labels set discogs_label_id = ? where slug = ? and discogs_label_id is null`,
  });
}

export async function setLabelMbLabelId(
  slug: string,
  mbLabelId: string,
  client?: Pick<Client, "execute">,
): Promise<void> {
  await persistLabelMbLabelIdInternal(slug, mbLabelId, client);
}

async function markResolved(slug: string, imageKey: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "label",
        {
          args: [slug],
          sql: `select id as subject_id from labels where slug = ?`,
        },
        { producer: "label-image-resolved" },
      ),
      {
        args: [imageKey, now, now, now, slug],
        sql: `update labels
              set image_key = ?, image_state = 'resolved', image_failures = 0,
                  image_attempted_at = ?, image_updated_at = ?, updated_at = ?
              where slug = ?`,
      },
    ],
    "write",
  );
}

async function markNone(slug: string): Promise<void> {
  const db = await getDb();

  await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "label",
        {
          args: [slug],
          sql: `select id as subject_id from labels where slug = ?`,
        },
        { producer: "label-image-none" },
      ),
      {
        args: [new Date().toISOString(), slug],
        sql: `update labels
              set image_state = 'none', image_failures = 0, image_attempted_at = ?
              where slug = ?`,
      },
    ],
    "write",
  );
}

async function recordFailure(slug: string, priorFailures: number): Promise<void> {
  const db = await getDb();
  const failures = priorFailures + 1;

  await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "label",
        {
          args: [slug],
          sql: `select id as subject_id from labels where slug = ?`,
        },
        { producer: "label-image-failure" },
      ),
      {
        args: [failures, new Date().toISOString(), slug],
        sql: `update labels
              set image_failures = ?, image_state = 'pending', image_attempted_at = ?
              where slug = ?`,
      },
    ],
    "write",
  );
}

async function storeLogo(
  bucket: Pick<R2Bucket, "put">,
  slug: string,
  image: DiscogsLabelImage,
): Promise<string> {
  const key = labelLogoKey(slug, image.mime);

  await bucket.put(key, image.bytes, {
    httpMetadata: { cacheControl: LABEL_LOGO_CACHE_CONTROL, contentType: image.mime },
  });

  return key;
}

async function resolveOneLabel(
  row: LabelWorkRow,
  bucket: Pick<R2Bucket, "put">,
  discogsToken: string | undefined,
  discogs: {
    boxFetch: boolean;
    candidatesPresent: boolean;
    supplied?: DiscogsLabelCandidate;
  },
): Promise<ResolveOutcome> {
  try {
    let mbid = row.mb_label_id;
    let discogsLabelId = row.discogs_label_id;
    let wikidataQid: string | null = null;

    if (!mbid) {
      const search = await searchMbLabelId(row.name);

      if (search.rateLimited) {
        return { kind: "rate-limited" };
      }

      mbid = search.mbid;

      if (mbid) {
        await persistLabelMbLabelIdInternal(row.slug, mbid);
      }
    }

    if (mbid) {
      const rels = await walkMbLabelRels(mbid);

      if (rels.rateLimited) {
        return { kind: "rate-limited" };
      }

      wikidataQid = rels.wikidataQid;

      if (rels.discogsLabelId !== null && discogsLabelId === null) {
        discogsLabelId = rels.discogsLabelId;
        await persistDiscogsLabelId(row.slug, discogsLabelId);
      }
    }

    if (discogsLabelId !== null && discogs.candidatesPresent) {
      const supplied = discogs.supplied;
      const evidence =
        supplied?.discogsLabelId === discogsLabelId
          ? verifyDiscogsLabelEvidence(supplied)
          : { kind: "invalid" as const };

      if (evidence.kind === "image") {
        const imageKey = await storeLogo(bucket, row.slug, evidence.image);

        return { imageKey, kind: "resolved", source: "discogs" };
      }

      if (evidence.kind === "invalid") {
        return { error: "Discogs label evidence failed Worker verification", kind: "failed" };
      }
    } else if (discogsLabelId !== null && discogs.boxFetch) {
      return { discogsLabelId, kind: "discogs-work" };
    } else if (discogsLabelId !== null && discogsToken) {
      const { image, rateLimited } = await fetchDiscogsLabelImage(discogsLabelId, discogsToken);

      if (rateLimited) {
        return { kind: "rate-limited" };
      }

      if (image) {
        const imageKey = await storeLogo(bucket, row.slug, image);

        return { imageKey, kind: "resolved", source: "discogs" };
      }
    }

    if (wikidataQid) {
      const wikidata = await fetchWikidataLogoImage(wikidataQid);

      if (wikidata.kind === "rate-limited") {
        return { kind: "rate-limited" };
      }

      if (wikidata.kind === "failed") {
        return wikidata;
      }

      if (wikidata.kind === "image") {
        const imageKey = await storeLogo(bucket, row.slug, wikidata.image);

        return { imageKey, kind: "resolved", source: "wikidata" };
      }
    }

    return { kind: "none" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

export async function resolveLabelImages(
  bucket: Pick<R2Bucket, "put">,
  limit: number,
  dryRun: boolean,
  cursor?: string,
  options: {
    boxFetch?: boolean;
    discogsCandidates?: DiscogsLabelCandidate[];
  } = {},
): Promise<LabelImagesResolveResult> {
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));
  const candidateSlugs = options.discogsCandidates?.map((candidate) => candidate.slug);

  if (options.discogsCandidates !== undefined && candidateSlugs?.length === 0) {
    return {
      discogsWork: [],
      dryRun,
      failed: [],
      failedCount: 0,
      nextCursor: null,
      none: [],
      noneCount: 0,
      rateLimited: false,
      resolved: [],
      resolvedCount: 0,
    };
  }

  const selectedCursor = candidateSlugs && candidateSlugs.length > 0 ? undefined : cursor;
  const selectedSlugs = candidateSlugs && candidateSlugs.length > 0 ? candidateSlugs : undefined;
  const rows = (await isDueWorkCutoverEnabled())
    ? await listProjectedLabels(batchLimit, selectedCursor, selectedSlugs)
    : await listPendingLabels(batchLimit, selectedCursor, selectedSlugs);

  const discogsWork: DiscogsLabelWork[] = [];
  const resolved: string[] = [];
  const none: string[] = [];
  const failed: Array<{ error: string; slug: string }> = [];
  let rateLimited = false;

  if (dryRun) {
    for (const row of rows) {
      resolved.push(row.slug);
    }
  } else {
    const discogsToken = await readOptionalEnv("DISCOGS_USER_TOKEN");
    const suppliedBySlug = new Map(
      (options.discogsCandidates ?? []).map((candidate) => [candidate.slug, candidate]),
    );

    for (const row of rows) {
      const supplied = suppliedBySlug.get(row.slug);
      const outcome = await resolveOneLabel(row, bucket, discogsToken, {
        boxFetch: options.boxFetch === true,
        candidatesPresent: options.discogsCandidates !== undefined,
        ...(supplied === undefined ? {} : { supplied }),
      });

      if (outcome.kind === "discogs-work") {
        discogsWork.push({ discogsLabelId: outcome.discogsLabelId, slug: row.slug });
        continue;
      }

      if (outcome.kind === "rate-limited") {
        rateLimited = true;
        break;
      }

      if (outcome.kind === "resolved") {
        await markResolved(row.slug, outcome.imageKey);
        logEvent("info", "label-images.resolved", {
          imageKey: outcome.imageKey,
          slug: row.slug,
          source: outcome.source,
        });
        resolved.push(row.slug);
        continue;
      }

      if (outcome.kind === "none") {
        await markNone(row.slug);
        none.push(row.slug);
        continue;
      }

      await recordFailure(row.slug, row.image_failures);
      failed.push({ error: outcome.error, slug: row.slug });
    }
  }

  const lastSlug = rows.at(-1)?.slug ?? null;
  const nextCursor = rateLimited || rows.length < batchLimit ? null : lastSlug;

  return {
    discogsWork,
    dryRun,
    failed,
    failedCount: failed.length,
    nextCursor,
    none,
    noneCount: none.length,
    rateLimited,
    resolved,
    resolvedCount: resolved.length,
  };
}

import { type Client } from "@libsql/client";
import { EMBEDDING_DIMS } from "../../src/lib/server/embedding";
import { SONAR_PORT } from "./stack";

const SECRET = "e2e-fake-sonar-secret";
const SUPPORTED_FILTERS = new Set(["bpm_min", "bpm_max", "key_in"]);

type Filter = { bpm_max?: number; bpm_min?: number; key_in?: string[] };
type SearchBody = {
  exclude_ids: string[];
  filter: Filter;
  index: "centroids" | "tracks";
  probes: number[][];
  top_k: number;
};
type Candidate = { bpm: number | null; id: string; key: string | null; vector: number[] };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMS &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function parseBody(value: unknown): SearchBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const body = value as Record<string, unknown>;
  const filter = body.filter === undefined ? {} : body.filter;

  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    return null;
  }

  const fields = filter as Record<string, unknown>;

  if (Object.keys(fields).some((field) => !SUPPORTED_FILTERS.has(field))) {
    return null;
  }

  if (
    (fields.bpm_min !== undefined &&
      (typeof fields.bpm_min !== "number" || !Number.isFinite(fields.bpm_min))) ||
    (fields.bpm_max !== undefined &&
      (typeof fields.bpm_max !== "number" || !Number.isFinite(fields.bpm_max))) ||
    (fields.key_in !== undefined &&
      (!Array.isArray(fields.key_in) || !fields.key_in.every((key) => typeof key === "string"))) ||
    (body.index !== "tracks" && body.index !== "centroids") ||
    !Array.isArray(body.probes) ||
    body.probes.length === 0 ||
    !body.probes.every(validVector) ||
    !Array.isArray(body.exclude_ids) ||
    !body.exclude_ids.every((id) => typeof id === "string") ||
    typeof body.top_k !== "number" ||
    !Number.isSafeInteger(body.top_k) ||
    body.top_k < 1
  ) {
    return null;
  }

  if (body.index === "centroids" && Object.keys(fields).length > 0) {
    return null;
  }

  return body as SearchBody;
}

function readVector(value: unknown): number[] {
  const decoded = typeof value === "string" ? (JSON.parse(value) as unknown) : value;

  if (!validVector(decoded)) {
    throw new Error("fake Sonar found a malformed seed vector");
  }

  return decoded;
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < EMBEDDING_DIMS; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

async function candidates(client: Client, index: SearchBody["index"]): Promise<Candidate[]> {
  const result = await client.execute(
    index === "tracks"
      ? `select t.track_id as id, vector_extract(e.embedding_blob) as v, t.bpm, t.key
         from track_embeddings e join tracks t on t.track_id = e.track_id`
      : `select artist_id as id, vector_extract(centroid_blob) as v from artist_centroids`,
  );

  return result.rows.map((row) => {
    if (typeof row.id !== "string") {
      throw new Error("fake Sonar found a candidate without a string id");
    }

    return {
      bpm: typeof row.bpm === "number" ? row.bpm : null,
      id: row.id,
      key: typeof row.key === "string" ? row.key : null,
      vector: readVector(row.v),
    };
  });
}

async function search(client: Client, body: SearchBody): Promise<Response> {
  const excluded = new Set(body.exclude_ids);
  const matches = (await candidates(client, body.index))
    .filter((candidate) => {
      if (excluded.has(candidate.id)) {
        return false;
      }

      const { bpm_min: min, bpm_max: max, key_in: keys } = body.filter;

      return (
        (min === undefined || (candidate.bpm !== null && candidate.bpm >= min)) &&
        (max === undefined || (candidate.bpm !== null && candidate.bpm <= max)) &&
        (keys === undefined || (candidate.key !== null && keys.includes(candidate.key)))
      );
    })
    .map((candidate) => ({
      id: candidate.id,
      score: Math.max(...body.probes.map((probe) => cosine(candidate.vector, probe))),
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, body.top_k);

  return json({ matches });
}

export function startFakeSonar(client: Client): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;

      if (request.method === "GET" && pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method !== "POST" || pathname !== "/search") {
        return json({ error: "not found" }, 404);
      }

      if (request.headers.get("x-sonar-secret") !== SECRET) {
        return json({ error: "unauthorized" }, 401);
      }

      let payload: unknown;

      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }

      const body = parseBody(payload);

      if (!body) {
        return json({ error: "unsupported or invalid search request" }, 400);
      }

      return search(client, body);
    },
    hostname: "127.0.0.1",
    port: SONAR_PORT,
  });
}

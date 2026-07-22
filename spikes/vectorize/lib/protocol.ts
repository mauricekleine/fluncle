// The wire contract shared by the Worker (src/worker.ts) and the Bun scripts
// (load.ts, recall-ab.ts). Pure types + a couple of pure helpers, no infra.

import { type TrackMetadata } from "./metadata";

export type IndexName = "tracks" | "centroids";

/** One line of a generated corpus NDJSON file (upsert-ready). */
export type CorpusRecord = {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
};

/** One line of the REAL-embedding export the operator produces for Proof B. */
export type RealExportRecord = {
  trackId: string;
  embedding: number[];
} & TrackMetadata;

/** POST /admin/load body. */
export type LoadRequest = {
  index: IndexName;
  vectors: CorpusRecord[];
};

export type LoadResponse = {
  mutationId: string;
  count: number;
};

/** POST /admin/query body — a raw values-array probe, mirroring the real design. */
export type QueryRequest = {
  index: IndexName;
  vector: number[];
  topK: number;
  filter?: Record<string, unknown>;
  returnValues?: boolean;
  returnMetadata?: boolean | "all" | "indexed" | "none";
  namespace?: string;
};

export type QueryMatch = {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export type QueryResponse = {
  matches: QueryMatch[];
  count: number;
};

export type DescribeResponse = {
  index: IndexName;
  vectorCount: number;
  dimensions: number;
  processedUpToMutation: number | null;
};

/** Parse a whole NDJSON string into typed records, skipping blank lines. */
export function parseNdjson<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}

/** Split an array into chunks of at most `size` (the ≤1000 upsert batch cap). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

import { type Client, type InStatement, type InValue } from "@libsql/client";

import { REC_ELIGIBLE_WHERE } from "../catalogue-eligibility";
import {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_PRIMARY_KEYS,
  type DeviceSourceTable,
} from "../../../scripts/lib/device-db-derivation";
import { getDb, typedRow, typedRows } from "./db";
import { ApiError } from "./spotify";

export const ARTIFACT_CHANGE_READ_LIMIT = 100;
export const ARTIFACT_CHANGE_MAX_READ_LIMIT = 500;
export const ARTIFACT_COMPACTION_MAX_LIMIT = 1_000;
export const ARTIFACT_SNAPSHOT_LIMIT = 100;
export const ARTIFACT_SNAPSHOT_MAX_LIMIT = 200;
export const ARTIFACT_VECTOR_BYTES = 1024 * Float32Array.BYTES_PER_ELEMENT;
export const ARTIFACT_PAYLOAD_JSON_MAX_BYTES = 256 * 1024;

const EMPTY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CONSUMER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const PRODUCER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SUBJECT_ID_MAX_CHARS = 1_024;
const UINT32_MAX = 4_294_967_295;

export type ArtifactOperation = "delete" | "upsert";
export type ArtifactConsumerState = "active" | "inactive" | "rebuilding";
export type ArtifactSnapshotStream = ArtifactStream;

type JsonScalar = boolean | number | string | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
type DevicePayload = Record<string, JsonScalar>;

type ArtifactStreamDefinition = {
  deviceTable?: DeviceSourceTable;
  formatVersion: 1;
  streamVersion: 1;
  subjectType: string;
  vectorBytes: number | null;
};

/**
 * The fail-closed producer/consumer registry. A stream exists only when its exact stream and
 * payload format versions are named here. Adding or changing a payload is a registry/version
 * change; an unknown tuple is rejected at every producer, registration, snapshot, and ack edge.
 */
export const ARTIFACT_STREAM_REGISTRY = {
  "device.album": {
    deviceTable: "albums",
    formatVersion: 1,
    streamVersion: 1,
    subjectType: "album",
    vectorBytes: null,
  },
  "device.artist": {
    deviceTable: "artists",
    formatVersion: 1,
    streamVersion: 1,
    subjectType: "artist",
    vectorBytes: null,
  },
  "device.finding": {
    deviceTable: "findings",
    formatVersion: 1,
    streamVersion: 1,
    subjectType: "finding",
    vectorBytes: null,
  },
  "device.label": {
    deviceTable: "labels",
    formatVersion: 1,
    streamVersion: 1,
    subjectType: "label",
    vectorBytes: null,
  },
  "device.track": {
    deviceTable: "tracks",
    formatVersion: 1,
    streamVersion: 1,
    subjectType: "track",
    vectorBytes: null,
  },
  "device.track-artist": {
    deviceTable: "track_artists",
    formatVersion: 1,
    streamVersion: 1,
    subjectType: "track_artist",
    vectorBytes: null,
  },
  "sonar.track": {
    formatVersion: 1,
    streamVersion: 1,
    subjectType: "track",
    vectorBytes: ARTIFACT_VECTOR_BYTES,
  },
} as const satisfies Record<string, ArtifactStreamDefinition>;

export type ArtifactStream = keyof typeof ARTIFACT_STREAM_REGISTRY;

export const ARTIFACT_STREAMS = Object.keys(ARTIFACT_STREAM_REGISTRY).sort() as ArtifactStream[];

export type ArtifactContract = {
  formatVersion: number;
  stream: ArtifactStream;
  streamVersion: number;
};

export const ARTIFACT_CONTRACTS: readonly ArtifactContract[] = ARTIFACT_STREAMS.map((stream) => {
  const definition = ARTIFACT_STREAM_REGISTRY[stream];

  return {
    formatVersion: definition.formatVersion,
    stream,
    streamVersion: definition.streamVersion,
  };
});

export type ArtifactChangeInput = ArtifactContract & {
  createdAt?: string;
  operation: ArtifactOperation;
  payload: unknown;
  payloadBlob?: ArrayBuffer | ArrayBufferView | null;
  producer: string;
  revision: number;
  subjectId: string;
  subjectType: string;
};

export type ArtifactChangeEvent = ArtifactContract & {
  createdAt: string;
  formatRegistered: boolean;
  operation: ArtifactOperation;
  payloadBlobBase64: string | null;
  payloadDigest: string;
  payloadJson: string;
  producer: string;
  revision: number;
  seq: number;
  subjectId: string;
  subjectType: string;
  supportedByConsumer: boolean;
};

export type ArtifactChangeInsertResult = {
  event: ArtifactChangeEvent;
  inserted: boolean;
};

export type ArtifactChangePage = {
  batchDigest: string;
  consumerId: string;
  events: ArtifactChangeEvent[];
  fromSeq: number;
  hasMore: boolean;
  headSeq: number;
  throughSeq: number;
};

export type ArtifactSnapshotItem = ArtifactContract & {
  operation: "upsert";
  payloadBlobBase64: string | null;
  payloadDigest: string;
  payloadJson: string;
  subjectId: string;
  subjectType: string;
};

export type ArtifactSnapshotPage = ArtifactContract & {
  complete: boolean;
  consumerId: string;
  cursor: string | null;
  generation: string;
  headSeq: number;
  itemCount: number;
  items: ArtifactSnapshotItem[];
  pageDigest: string;
  snapshotSeq: number;
  sourceDigest: string;
};

export type ArtifactRebuildCheckpoint = ArtifactContract & {
  completedAt: string | null;
  consumerDigest: string;
  consumerItemCount: number;
  cursor: string | null;
  generation: string;
  snapshotSeq: number;
  sourceDigest: string;
  sourceItemCount: number;
  startedAt: string;
  state: "complete" | "running";
  updatedAt: string;
};

export type ArtifactConsumerStatus = {
  appliedThroughSeq: number | null;
  checkpointedAt: string | null;
  compactionBarrier: number | null;
  consumerId: string;
  contracts: ArtifactContract[];
  earliestSeq: number | null;
  headSeq: number;
  rebuilds: ArtifactRebuildCheckpoint[];
  registeredAt: string;
  snapshotSeq: number | null;
  state: ArtifactConsumerState;
  stateChangedAt: string;
  updatedAt: string;
};

export type ArtifactCompactionResult = {
  barrier: number | null;
  deletedCount: number;
  deletedFromSeq: number | null;
  deletedThroughSeq: number | null;
  reason: "compacted" | "empty" | "no_safe_barrier";
};

type ArtifactClient = Pick<Client, "batch" | "execute" | "transaction">;
type ArtifactReadClient = Pick<Client, "batch" | "execute">;

type ArtifactChangeRow = {
  created_at: string;
  format_version: bigint | number;
  operation: ArtifactOperation;
  payload_blob: ArrayBuffer | ArrayBufferView | null;
  payload_json: string;
  producer: string;
  revision: bigint | number;
  seq: bigint | number;
  stream: string;
  stream_version: bigint | number;
  subject_id: string;
  subject_type: string;
};

type ArtifactRevisionRow = {
  content_digest: string;
  created_at: string;
  event_seq: bigint | number;
  producer: string;
};

type ArtifactSubject = ArtifactContract & {
  subjectId: string;
  subjectType: string;
};

type ArtifactConsumerRow = {
  applied_through_seq: bigint | number | null;
  checkpointed_at: string | null;
  consumer_id: string;
  registered_at: string;
  snapshot_seq: bigint | number | null;
  state: ArtifactConsumerState;
  state_changed_at: string;
  updated_at: string;
};

type ArtifactContractRow = {
  format_version: bigint | number;
  stream: string;
  stream_version: bigint | number;
};

type ArtifactCheckpointRow = ArtifactContractRow & {
  completed_at: string | null;
  consumer_digest: string | null;
  consumer_item_count: bigint | number;
  cursor: string | null;
  generation: string;
  snapshot_seq: bigint | number;
  source_digest: string | null;
  source_item_count: bigint | number;
  started_at: string;
  state: "complete" | "running";
  updated_at: string;
};

type ValidatedArtifactChange = ArtifactContract & {
  createdAt: string;
  operation: ArtifactOperation;
  payloadBlob: Uint8Array | null;
  payloadJson: string;
  producer: string;
  revision: number;
  subjectId: string;
  subjectType: string;
};

function apiError(code: string, message: string, status = 400): never {
  throw new ApiError(code, message, status);
}

function ownRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    apiError("invalid_artifact_payload", "Artifact payload must be a JSON object");
  }

  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();

  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    apiError(
      "invalid_artifact_payload",
      `${label} payload keys must be exactly: ${wanted.join(", ")}`,
    );
  }
}

function jsonScalar(value: unknown, label: string): JsonScalar {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint" && Number.isSafeInteger(Number(value))) {
    return Number(value);
  }

  apiError("invalid_artifact_payload", `${label} must be a finite JSON scalar`);
}

function canonicalValue(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      apiError("invalid_artifact_payload", "Artifact payload numbers must be finite");
    }

    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key] ?? null)}`)
    .join(",")}}`;
}

export function canonicalArtifactJson(value: JsonValue): string {
  return canonicalValue(value);
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function ownedBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return Uint8Array.from(bytesOf(value));
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function artifactBytesToBase64(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = bytesOf(value);
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function sha256(parts: readonly Uint8Array[]): Promise<string> {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
  if (!DIGEST_PATTERN.test(value)) {
    apiError("invalid_digest", "Digest must be a lowercase SHA-256 hex string");
  }

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

async function payloadDigest(
  envelope: Record<string, JsonValue>,
  payloadBlob: Uint8Array | null,
): Promise<string> {
  const header = new TextEncoder().encode(canonicalArtifactJson(envelope));
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(payloadBlob?.byteLength ?? 0), false);

  return sha256([header, length, payloadBlob ?? new Uint8Array()]);
}

async function immutableContentDigest(event: ValidatedArtifactChange): Promise<string> {
  return payloadDigest(
    {
      formatVersion: event.formatVersion,
      operation: event.operation,
      payloadJson: event.payloadJson,
      revision: event.revision,
      stream: event.stream,
      streamVersion: event.streamVersion,
      subjectId: event.subjectId,
      subjectType: event.subjectType,
    },
    event.payloadBlob,
  );
}

async function extendDigest(previous: string, itemDigests: readonly string[]): Promise<string> {
  if (itemDigests.length === 0) {
    return previous;
  }

  return sha256([hexBytes(previous), ...itemDigests.map(hexBytes)]);
}

function registeredStream(stream: string): ArtifactStreamDefinition & { stream: ArtifactStream } {
  if (!Object.hasOwn(ARTIFACT_STREAM_REGISTRY, stream)) {
    apiError("unknown_artifact_stream", `Unsupported artifact stream: ${stream}`);
  }

  const registered = stream as ArtifactStream;
  return { ...ARTIFACT_STREAM_REGISTRY[registered], stream: registered };
}

export function artifactContract(stream: ArtifactStream): ArtifactContract {
  const definition = ARTIFACT_STREAM_REGISTRY[stream];

  return {
    formatVersion: definition.formatVersion,
    stream,
    streamVersion: definition.streamVersion,
  };
}

function validateContract(contract: {
  formatVersion: number;
  stream: string;
  streamVersion: number;
}): ArtifactContract {
  const definition = registeredStream(contract.stream);

  if (
    contract.streamVersion !== definition.streamVersion ||
    contract.formatVersion !== definition.formatVersion
  ) {
    apiError(
      "unknown_artifact_version",
      `Unsupported artifact contract: ${contract.stream}@${contract.streamVersion}/${contract.formatVersion}`,
    );
  }

  return {
    formatVersion: definition.formatVersion,
    stream: definition.stream,
    streamVersion: definition.streamVersion,
  };
}

function validateSonarPayload(payload: unknown): Record<string, JsonValue> {
  const value = ownRecord(payload);
  const keys = [
    "anchored",
    "bpm",
    "certified",
    "dismissed",
    "durationMs",
    "hasFinding",
    "isDuplicate",
    "key",
    "nearestFindingScore",
  ] as const;
  exactKeys(value, keys, "sonar.track");

  for (const key of ["anchored", "certified", "dismissed", "hasFinding", "isDuplicate"] as const) {
    if (typeof value[key] !== "boolean") {
      apiError("invalid_artifact_payload", `sonar.track.${key} must be boolean`);
    }
  }

  if (value.key !== null && typeof value.key !== "string") {
    apiError("invalid_artifact_payload", "sonar.track.key must be a string or null");
  }

  for (const key of ["bpm", "nearestFindingScore"] as const) {
    if (value[key] !== null && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      apiError("invalid_artifact_payload", `sonar.track.${key} must be finite or null`);
    }
  }

  if (
    value.durationMs !== null &&
    (typeof value.durationMs !== "number" ||
      !Number.isInteger(value.durationMs) ||
      value.durationMs < 0 ||
      value.durationMs > UINT32_MAX)
  ) {
    apiError("invalid_artifact_payload", "sonar.track.durationMs must be a uint32 integer or null");
  }

  return {
    anchored: value.anchored as boolean,
    bpm: value.bpm as number | null,
    certified: value.certified as boolean,
    dismissed: value.dismissed as boolean,
    durationMs: value.durationMs as number | null,
    hasFinding: value.hasFinding as boolean,
    isDuplicate: value.isDuplicate as boolean,
    key: value.key as string | null,
    nearestFindingScore: value.nearestFindingScore as number | null,
  };
}

function deviceDefinition(definition: ArtifactStreamDefinition): {
  columns: readonly string[];
  keys: readonly string[];
  table: DeviceSourceTable;
} {
  const table = definition.deviceTable;

  if (table === undefined) {
    apiError("invalid_artifact_payload", "Artifact stream is not a device projection");
  }

  return {
    columns: DEVICE_DB_COLUMNS[table],
    keys: DEVICE_DB_PRIMARY_KEYS[table],
    table,
  };
}

function validateDevicePayload(
  definition: ArtifactStreamDefinition,
  operation: ArtifactOperation,
  payload: unknown,
): DevicePayload {
  const { columns, keys, table } = deviceDefinition(definition);
  const expected = operation === "delete" ? keys : columns;
  const value = ownRecord(payload);
  exactKeys(value, expected, `${table}.${operation}`);

  return Object.fromEntries(
    expected.map((column) => [column, jsonScalar(value[column], `${table}.${column}`)]),
  );
}

function deviceSubjectId(definition: ArtifactStreamDefinition, payload: DevicePayload): string {
  const { keys } = deviceDefinition(definition);
  const values = keys.map((key) => payload[key]);

  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    apiError("invalid_artifact_subject", "Device artifact primary keys must be non-empty strings");
  }

  return values.length === 1 ? (values[0] as string) : canonicalArtifactJson(values as JsonValue[]);
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit <= 31 || codeUnit === 127) {
      return true;
    }
  }

  return false;
}

function validateArtifactChange(input: ArtifactChangeInput): ValidatedArtifactChange {
  const contract = validateContract(input);
  const definition: ArtifactStreamDefinition = ARTIFACT_STREAM_REGISTRY[contract.stream];

  if (input.subjectType !== definition.subjectType) {
    apiError(
      "invalid_artifact_subject",
      `${contract.stream} subjectType must be ${definition.subjectType}`,
    );
  }

  if (
    typeof input.subjectId !== "string" ||
    input.subjectId.length === 0 ||
    input.subjectId.length > SUBJECT_ID_MAX_CHARS ||
    hasUnsafeControlCharacter(input.subjectId)
  ) {
    apiError("invalid_artifact_subject", "Artifact subjectId is empty, too long, or unsafe");
  }

  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    apiError("invalid_artifact_revision", "Artifact revision must be a positive safe integer");
  }

  if (!PRODUCER_PATTERN.test(input.producer)) {
    apiError("invalid_artifact_producer", "Artifact producer has an invalid identifier");
  }

  if (input.operation !== "upsert" && input.operation !== "delete") {
    apiError("invalid_artifact_operation", "Artifact operation must be upsert or delete");
  }

  let payload: JsonValue;
  let payloadBlob: Uint8Array | null;

  if (definition.deviceTable !== undefined) {
    const devicePayload = validateDevicePayload(definition, input.operation, input.payload);
    const expectedSubjectId = deviceSubjectId(definition, devicePayload);

    if (input.subjectId !== expectedSubjectId) {
      apiError(
        "invalid_artifact_subject",
        `${contract.stream} subjectId does not match its primary-key payload`,
      );
    }

    payload = devicePayload;
    payloadBlob = null;

    if (input.payloadBlob !== undefined && input.payloadBlob !== null) {
      apiError("invalid_artifact_payload", `${contract.stream} never carries a blob`);
    }
  } else if (input.operation === "delete") {
    const tombstone = ownRecord(input.payload);
    exactKeys(tombstone, [], "sonar.track delete");
    payload = {};
    payloadBlob = null;

    if (input.payloadBlob !== undefined && input.payloadBlob !== null) {
      apiError("invalid_artifact_payload", "Delete tombstones cannot carry a vector blob");
    }
  } else {
    payload = validateSonarPayload(input.payload);

    if (input.payloadBlob === undefined || input.payloadBlob === null) {
      apiError("invalid_artifact_payload", "sonar.track upserts require an F32 blob");
    }

    payloadBlob = ownedBytes(input.payloadBlob);

    if (payloadBlob.byteLength !== ARTIFACT_VECTOR_BYTES) {
      apiError(
        "invalid_artifact_payload",
        `sonar.track vector must be exactly ${ARTIFACT_VECTOR_BYTES} bytes`,
      );
    }
  }

  const payloadJson = canonicalArtifactJson(payload);

  if (new TextEncoder().encode(payloadJson).byteLength > ARTIFACT_PAYLOAD_JSON_MAX_BYTES) {
    apiError("invalid_artifact_payload", "Artifact JSON payload exceeds the hard byte limit");
  }

  const createdAt = input.createdAt ?? new Date().toISOString();

  if (createdAt.length === 0 || createdAt.length > 64) {
    apiError("invalid_artifact_timestamp", "Artifact createdAt is empty or too long");
  }

  return {
    ...contract,
    createdAt,
    operation: input.operation,
    payloadBlob,
    payloadJson,
    producer: input.producer,
    revision: input.revision,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
  };
}

function inBlob(value: Uint8Array | null): InValue {
  if (value === null) {
    return null;
  }

  return Uint8Array.from(value);
}

/**
 * Build only the validated event-body statement. Source writers must call
 * insertArtifactChangeInTransaction so the durable retry receipt lands in the same transaction.
 */
export function buildArtifactChangeInsertStatement(input: ArtifactChangeInput): InStatement {
  const event = validateArtifactChange(input);

  return {
    args: [
      event.createdAt,
      event.formatVersion,
      event.operation,
      inBlob(event.payloadBlob),
      event.payloadJson,
      event.producer,
      event.revision,
      event.stream,
      event.streamVersion,
      event.subjectId,
      event.subjectType,
    ],
    sql: `insert into artifact_changes
      (created_at, format_version, operation, payload_blob, payload_json, producer, revision,
       stream, stream_version, subject_id, subject_type)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (stream, stream_version, subject_type, subject_id, revision) do nothing
      returning created_at, format_version, operation, payload_blob, payload_json, producer,
                revision, seq, stream, stream_version, subject_id, subject_type`,
  };
}

export function buildSonarTrackArtifactChange(input: {
  createdAt?: string;
  operation: ArtifactOperation;
  payload: unknown;
  producer: string;
  revision: number;
  trackId: string;
  vector?: ArrayBuffer | ArrayBufferView | null;
}): InStatement {
  return buildArtifactChangeInsertStatement({
    ...artifactContract("sonar.track"),
    createdAt: input.createdAt,
    operation: input.operation,
    payload: input.payload,
    payloadBlob: input.vector,
    producer: input.producer,
    revision: input.revision,
    subjectId: input.trackId,
    subjectType: "track",
  });
}

export function buildDeviceArtifactChange(input: {
  createdAt?: string;
  operation: ArtifactOperation;
  payload: unknown;
  producer: string;
  revision: number;
  stream: Exclude<ArtifactStream, "sonar.track">;
  subjectId: string;
}): InStatement {
  const definition = ARTIFACT_STREAM_REGISTRY[input.stream];

  return buildArtifactChangeInsertStatement({
    ...artifactContract(input.stream),
    createdAt: input.createdAt,
    operation: input.operation,
    payload: input.payload,
    producer: input.producer,
    revision: input.revision,
    subjectId: input.subjectId,
    subjectType: definition.subjectType,
  });
}

function artifactRowBlob(row: ArtifactChangeRow): Uint8Array | null {
  return row.payload_blob === null ? null : ownedBytes(row.payload_blob);
}

function exactEventMatches(row: ArtifactChangeRow, event: ValidatedArtifactChange): boolean {
  return (
    Number(row.format_version) === event.formatVersion &&
    row.operation === event.operation &&
    row.payload_json === event.payloadJson &&
    Number(row.revision) === event.revision &&
    row.stream === event.stream &&
    Number(row.stream_version) === event.streamVersion &&
    row.subject_id === event.subjectId &&
    row.subject_type === event.subjectType &&
    bytesEqual(artifactRowBlob(row), event.payloadBlob)
  );
}

function revisionEvent(
  row: ArtifactRevisionRow,
  event: ValidatedArtifactChange,
): ArtifactChangeRow {
  return {
    created_at: row.created_at,
    format_version: event.formatVersion,
    operation: event.operation,
    payload_blob: event.payloadBlob,
    payload_json: event.payloadJson,
    producer: row.producer,
    revision: event.revision,
    seq: row.event_seq,
    stream: event.stream,
    stream_version: event.streamVersion,
    subject_id: event.subjectId,
    subject_type: event.subjectType,
  };
}

async function insertRevisionReceipt(
  client: Pick<Client, "execute">,
  event: ValidatedArtifactChange,
  eventSeq: number,
  contentDigest: string,
): Promise<void> {
  await client.execute({
    args: [
      contentDigest,
      event.createdAt,
      eventSeq,
      event.producer,
      event.revision,
      event.stream,
      event.streamVersion,
      event.subjectId,
      event.subjectType,
    ],
    sql: `insert into artifact_change_revisions
      (content_digest, created_at, event_seq, producer, revision, stream, stream_version,
       subject_id, subject_type)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function eventFromRow(
  row: ArtifactChangeRow,
  contracts: readonly ArtifactContract[],
): Promise<ArtifactChangeEvent> {
  const payloadBlob = artifactRowBlob(row);
  const streamVersion = Number(row.stream_version);
  const formatVersion = Number(row.format_version);
  const registered = Object.hasOwn(ARTIFACT_STREAM_REGISTRY, row.stream)
    ? ARTIFACT_STREAM_REGISTRY[row.stream as ArtifactStream]
    : undefined;
  const formatRegistered =
    registered !== undefined &&
    registered.streamVersion === streamVersion &&
    registered.formatVersion === formatVersion &&
    registered.subjectType === row.subject_type;
  const supportedByConsumer = contracts.some(
    (contract) =>
      contract.stream === row.stream &&
      contract.streamVersion === streamVersion &&
      contract.formatVersion === formatVersion,
  );
  const envelope = {
    createdAt: row.created_at,
    formatVersion,
    operation: row.operation,
    payloadJson: row.payload_json,
    producer: row.producer,
    revision: Number(row.revision),
    seq: Number(row.seq),
    stream: row.stream,
    streamVersion,
    subjectId: row.subject_id,
    subjectType: row.subject_type,
  } satisfies Record<string, JsonValue>;

  return {
    createdAt: row.created_at,
    formatRegistered,
    formatVersion,
    operation: row.operation,
    payloadBlobBase64: payloadBlob === null ? null : artifactBytesToBase64(payloadBlob),
    payloadDigest: await payloadDigest(envelope, payloadBlob),
    payloadJson: row.payload_json,
    producer: row.producer,
    revision: Number(row.revision),
    seq: Number(row.seq),
    stream: row.stream as ArtifactStream,
    streamVersion,
    subjectId: row.subject_id,
    subjectType: row.subject_type,
    supportedByConsumer,
  };
}

const ARTIFACT_CHANGE_SELECT = `created_at, format_version, operation, payload_blob, payload_json,
  producer, revision, seq, stream, stream_version, subject_id, subject_type`;

async function latestArtifactRevisionInTransaction(
  client: Pick<Client, "execute">,
  subject: ArtifactSubject,
): Promise<number> {
  const latestResult = await client.execute({
    args: [
      subject.stream,
      subject.streamVersion,
      subject.subjectType,
      subject.subjectId,
      subject.stream,
      subject.streamVersion,
      subject.subjectType,
      subject.subjectId,
    ],
    sql: `select max(revision) as revision
      from (
        select revision from artifact_change_revisions
        where stream = ? and stream_version = ? and subject_type = ? and subject_id = ?
        union all
        select revision from artifact_changes
        where stream = ? and stream_version = ? and subject_type = ? and subject_id = ?
      )`,
  });

  return Number(typedRow<{ revision: bigint | number | null }>(latestResult.rows)?.revision ?? 0);
}

/**
 * Append one material revision inside the caller's source write transaction. An exact retry
 * returns the immutable existing event; reusing the revision for different bytes fails, and a
 * stale revision cannot land after a newer one.
 */
export async function insertArtifactChangeInTransaction(
  client: Pick<Client, "execute">,
  input: ArtifactChangeInput,
): Promise<ArtifactChangeInsertResult> {
  const validated = validateArtifactChange(input);
  const contentDigest = await immutableContentDigest(validated);
  const revisionResult = await client.execute({
    args: [
      validated.stream,
      validated.streamVersion,
      validated.subjectType,
      validated.subjectId,
      validated.revision,
    ],
    sql: `select content_digest, created_at, event_seq, producer
      from artifact_change_revisions
      where stream = ? and stream_version = ? and subject_type = ? and subject_id = ?
        and revision = ?`,
  });
  const revision = typedRow<ArtifactRevisionRow>(revisionResult.rows);

  if (revision !== undefined) {
    if (revision.content_digest !== contentDigest) {
      apiError(
        "artifact_revision_conflict",
        "Artifact revision already exists with different immutable content",
        409,
      );
    }

    return {
      event: await eventFromRow(revisionEvent(revision, validated), []),
      inserted: false,
    };
  }

  const existingResult = await client.execute({
    args: [
      validated.stream,
      validated.streamVersion,
      validated.subjectType,
      validated.subjectId,
      validated.revision,
    ],
    sql: `select ${ARTIFACT_CHANGE_SELECT}
        from artifact_changes
        where stream = ? and stream_version = ? and subject_type = ? and subject_id = ?
          and revision = ?`,
  });
  const existing = typedRow<ArtifactChangeRow>(existingResult.rows);

  if (existing !== undefined) {
    if (!exactEventMatches(existing, validated)) {
      apiError(
        "artifact_revision_conflict",
        "Artifact revision already exists with different immutable content",
        409,
      );
    }

    await insertRevisionReceipt(client, validated, Number(existing.seq), contentDigest);
    return { event: await eventFromRow(existing, []), inserted: false };
  }

  const latest = await latestArtifactRevisionInTransaction(client, validated);

  if (validated.revision <= latest) {
    apiError(
      "artifact_revision_regression",
      `Artifact revision must be greater than the current revision ${latest}`,
      409,
    );
  }

  const insertedResult = await client.execute(buildArtifactChangeInsertStatement(input));
  const inserted = typedRow<ArtifactChangeRow>(insertedResult.rows);

  if (inserted === undefined) {
    apiError("artifact_revision_conflict", "Artifact revision raced another writer", 409);
  }

  await insertRevisionReceipt(client, validated, Number(inserted.seq), contentDigest);
  return { event: await eventFromRow(inserted, []), inserted: true };
}

/** Open a write transaction and append one material revision atomically. */
export async function insertArtifactChange(
  client: ArtifactClient,
  input: ArtifactChangeInput,
): Promise<ArtifactChangeInsertResult> {
  const transaction = await client.transaction("write");

  try {
    const result = await insertArtifactChangeInTransaction(transaction, input);
    await transaction.commit();
    return result;
  } finally {
    transaction.close();
  }
}

function assertConsumerId(consumerId: string): void {
  if (!CONSUMER_ID_PATTERN.test(consumerId)) {
    apiError(
      "invalid_artifact_consumer",
      "Consumer id must be 1-128 lowercase identifier characters",
    );
  }
}

function assertLimit(limit: number, maximum: number, label: string): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    apiError("invalid_limit", `${label} limit must be between 1 and ${maximum}`);
  }
}

function normalizeContracts(contracts: readonly ArtifactContract[]): ArtifactContract[] {
  if (contracts.length === 0 || contracts.length > ARTIFACT_CONTRACTS.length) {
    apiError(
      "invalid_artifact_contracts",
      `Declare between 1 and ${ARTIFACT_CONTRACTS.length} artifact contracts`,
    );
  }

  const normalized = contracts.map(validateContract);
  const identities = normalized.map(
    (contract) => `${contract.stream}@${contract.streamVersion}/${contract.formatVersion}`,
  );

  if (new Set(identities).size !== identities.length) {
    apiError("invalid_artifact_contracts", "Artifact contract declarations must be unique");
  }

  return normalized.sort((left, right) => left.stream.localeCompare(right.stream));
}

async function artifactHead(client: Pick<Client, "execute">): Promise<number> {
  const result = await client.execute(
    `select coalesce((select seq from sqlite_sequence where name = 'artifact_changes'), 0) as seq`,
  );

  return Number(typedRow<{ seq: bigint | number }>(result.rows)?.seq ?? 0);
}

async function readConsumer(
  client: Pick<Client, "execute">,
  consumerId: string,
): Promise<ArtifactConsumerRow> {
  const result = await client.execute({
    args: [consumerId],
    sql: `select applied_through_seq, checkpointed_at, consumer_id, registered_at, snapshot_seq,
                 state, state_changed_at, updated_at
      from artifact_change_consumers
      where consumer_id = ?`,
  });
  const consumer = typedRow<ArtifactConsumerRow>(result.rows);

  if (consumer === undefined) {
    apiError("artifact_consumer_not_found", `Unknown artifact consumer: ${consumerId}`, 404);
  }

  return consumer;
}

async function readContracts(
  client: Pick<Client, "execute">,
  consumerId: string,
): Promise<ArtifactContract[]> {
  const result = await client.execute({
    args: [consumerId],
    sql: `select format_version, stream, stream_version
      from artifact_change_consumer_contracts
      where consumer_id = ?
      order by stream, stream_version, format_version`,
  });

  return typedRows<ArtifactContractRow>(result.rows).map((row) => ({
    formatVersion: Number(row.format_version),
    stream: row.stream as ArtifactStream,
    streamVersion: Number(row.stream_version),
  }));
}

function generationId(consumerId: string, snapshotSeq: number, stream: ArtifactStream): string {
  return `${consumerId}:${snapshotSeq}:${stream}:${crypto.randomUUID()}`;
}

/** Register or re-register a consumer. Every call starts a fresh fenced rebuild. */
export async function registerArtifactConsumer(
  client: ArtifactClient,
  input: { consumerId: string; contracts: readonly ArtifactContract[] },
  options: { now?: string } = {},
): Promise<ArtifactConsumerStatus> {
  assertConsumerId(input.consumerId);
  const contracts = normalizeContracts(input.contracts);
  const now = options.now ?? new Date().toISOString();
  const transaction = await client.transaction("write");

  try {
    const snapshotSeq = await artifactHead(transaction);
    const existingResult = await transaction.execute({
      args: [input.consumerId],
      sql: `select registered_at from artifact_change_consumers where consumer_id = ?`,
    });
    const registeredAt =
      typedRow<{ registered_at: string }>(existingResult.rows)?.registered_at ?? now;

    await transaction.execute({
      args: [input.consumerId, registeredAt, snapshotSeq, now, now],
      sql: `insert into artifact_change_consumers
        (consumer_id, registered_at, snapshot_seq, state, state_changed_at, updated_at)
        values (?, ?, ?, 'rebuilding', ?, ?)
        on conflict (consumer_id) do update set
          applied_through_seq = null,
          checkpointed_at = null,
          snapshot_seq = excluded.snapshot_seq,
          state = 'rebuilding',
          state_changed_at = excluded.state_changed_at,
          updated_at = excluded.updated_at`,
    });
    await transaction.execute({
      args: [input.consumerId],
      sql: "delete from artifact_change_checkpoints where consumer_id = ?",
    });
    await transaction.execute({
      args: [input.consumerId],
      sql: "delete from artifact_change_consumer_contracts where consumer_id = ?",
    });

    for (const contract of contracts) {
      await transaction.execute({
        args: [
          input.consumerId,
          now,
          contract.formatVersion,
          contract.stream,
          contract.streamVersion,
        ],
        sql: `insert into artifact_change_consumer_contracts
          (consumer_id, declared_at, format_version, stream, stream_version)
          values (?, ?, ?, ?, ?)`,
      });
      await transaction.execute({
        args: [
          input.consumerId,
          EMPTY_DIGEST,
          generationId(input.consumerId, snapshotSeq, contract.stream),
          snapshotSeq,
          EMPTY_DIGEST,
          now,
          contract.stream,
          contract.streamVersion,
          now,
        ],
        sql: `insert into artifact_change_checkpoints
          (consumer_id, consumer_digest, consumer_item_count, cursor, generation, phase,
           snapshot_seq, source_digest, source_item_count, started_at, state, stream,
           stream_version, updated_at)
          values (?, ?, 0, null, ?, 'rebuild', ?, ?, 0, ?, 'running', ?, ?, ?)`,
      });
    }

    await transaction.commit();
  } finally {
    transaction.close();
  }

  return getArtifactConsumerStatus(client, input.consumerId);
}

function checkpointFromRow(row: ArtifactCheckpointRow): ArtifactRebuildCheckpoint {
  return {
    completedAt: row.completed_at,
    consumerDigest: row.consumer_digest ?? EMPTY_DIGEST,
    consumerItemCount: Number(row.consumer_item_count),
    cursor: row.cursor,
    formatVersion: row.format_version === undefined ? 1 : Number(row.format_version),
    generation: row.generation,
    snapshotSeq: Number(row.snapshot_seq),
    sourceDigest: row.source_digest ?? EMPTY_DIGEST,
    sourceItemCount: Number(row.source_item_count),
    startedAt: row.started_at,
    state: row.state,
    stream: row.stream as ArtifactStream,
    streamVersion: Number(row.stream_version),
    updatedAt: row.updated_at,
  };
}

async function readRebuildCheckpoint(
  client: Pick<Client, "execute">,
  consumerId: string,
  contract: ArtifactContract,
): Promise<ArtifactRebuildCheckpoint> {
  const result = await client.execute({
    args: [consumerId, contract.stream, contract.streamVersion],
    sql: `select checkpoint.completed_at, checkpoint.consumer_digest,
                 checkpoint.consumer_item_count, checkpoint.cursor, checkpoint.generation,
                 contract.format_version, checkpoint.snapshot_seq, checkpoint.source_digest,
                 checkpoint.source_item_count, checkpoint.started_at, checkpoint.state,
                 checkpoint.stream, checkpoint.stream_version, checkpoint.updated_at
      from artifact_change_checkpoints checkpoint
      join artifact_change_consumer_contracts contract
        on contract.consumer_id = checkpoint.consumer_id
       and contract.stream = checkpoint.stream
       and contract.stream_version = checkpoint.stream_version
      where checkpoint.consumer_id = ? and checkpoint.stream = ?
        and checkpoint.stream_version = ? and checkpoint.phase = 'rebuild'`,
  });
  const row = typedRow<ArtifactCheckpointRow>(result.rows);

  if (row === undefined) {
    apiError(
      "artifact_rebuild_not_found",
      `No rebuild checkpoint for ${consumerId}/${contract.stream}`,
      404,
    );
  }

  return checkpointFromRow(row);
}

function encodeSnapshotCursor(values: readonly string[]): string {
  const json = canonicalArtifactJson(values as JsonValue[]);
  const bytes = new TextEncoder().encode(json);

  return artifactBytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeSnapshotCursor(cursor: string | null, width: number): string[] {
  if (cursor === null) {
    return [];
  }

  try {
    const standard = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(padded))) as unknown;

    if (
      !Array.isArray(parsed) ||
      parsed.length !== width ||
      parsed.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      apiError("invalid_artifact_cursor", "Artifact snapshot cursor has the wrong shape");
    }

    return parsed as string[];
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    apiError("invalid_artifact_cursor", "Artifact snapshot cursor is malformed");
  }
}

function keysetWhere(
  alias: string,
  keys: readonly string[],
  after: readonly string[],
): {
  args: InValue[];
  sql: string;
} {
  if (after.length === 0) {
    return { args: [], sql: "" };
  }

  if (keys.length === 1) {
    return { args: [after[0] ?? ""], sql: ` and ${alias}.\`${keys[0]}\` > ?` };
  }

  const first = keys[0] ?? "";
  const second = keys[1] ?? "";

  return {
    args: [after[0] ?? "", after[0] ?? "", after[1] ?? ""],
    sql: ` and (${alias}.\`${first}\` > ?
      or (${alias}.\`${first}\` = ? and ${alias}.\`${second}\` > ?))`,
  };
}

function projectedColumns(alias: string, columns: readonly string[]): string {
  return columns.map((column) => `${alias}.\`${column}\` as \`${column}\``).join(", ");
}

const SONAR_TRACK_SOURCE_COLUMNS = `t.track_id, e.embedding_blob, t.key, t.bpm, t.spotify_uri,
  f.track_id as finding_id, f.log_id as finding_log_id, t.dismissed_at,
  t.duplicate_of_track_id, t.nearest_finding_score, t.duration_ms`;

function deviceSelectedTrackPredicate(): string {
  return `(f.track_id is not null or (${REC_ELIGIBLE_WHERE}))`;
}

export function buildArtifactSnapshotStatement(
  stream: ArtifactStream,
  cursor: string | null,
  limit: number,
): InStatement {
  assertLimit(limit, ARTIFACT_SNAPSHOT_MAX_LIMIT, "Artifact snapshot");
  const definition = ARTIFACT_STREAM_REGISTRY[stream];

  if (stream === "sonar.track") {
    const after = decodeSnapshotCursor(cursor, 1);
    const keyset = keysetWhere("t", ["track_id"], after);

    return {
      args: [...keyset.args, limit + 1],
      sql: `select ${SONAR_TRACK_SOURCE_COLUMNS}
        from tracks t
        join track_embeddings e on e.track_id = t.track_id
        left join findings f on f.track_id = t.track_id
        where length(e.embedding_blob) = ${ARTIFACT_VECTOR_BYTES}${keyset.sql}
        order by t.track_id
        limit ?`,
    };
  }

  const { columns, keys, table } = deviceDefinition(definition);
  const alias = table === "track_artists" ? "ta" : "source_row";
  const after = decodeSnapshotCursor(cursor, keys.length);
  const keyset = keysetWhere(alias, keys, after);
  const order = keys.map((key) => `${alias}.\`${key}\``).join(", ");
  const select = projectedColumns(alias, columns);
  let from: string;
  let predicate: string;

  if (table === "tracks") {
    from = `tracks source_row
      left join findings f on f.track_id = source_row.track_id
      left join track_embeddings emb on emb.track_id = source_row.track_id`;
    predicate = deviceSelectedTrackPredicate().replaceAll("t.", "source_row.");
  } else if (table === "findings") {
    from = "findings source_row";
    predicate = "1 = 1";
  } else if (table === "track_artists") {
    from = "track_artists ta";
    predicate = `exists (
      select 1
      from tracks t
      left join findings f on f.track_id = t.track_id
      left join track_embeddings emb on emb.track_id = t.track_id
      where t.track_id = ta.track_id and ${deviceSelectedTrackPredicate()}
    )`;
  } else if (table === "artists") {
    from = "artists source_row";
    predicate = `exists (
      select 1
      from track_artists ta
      join tracks t on t.track_id = ta.track_id
      left join findings f on f.track_id = t.track_id
      left join track_embeddings emb on emb.track_id = t.track_id
      where ta.artist_id = source_row.id and ${deviceSelectedTrackPredicate()}
    )`;
  } else {
    const pointer = table === "labels" ? "label_id" : "album_id";
    from = `${table} source_row`;
    predicate = `exists (
      select 1
      from tracks t
      left join findings f on f.track_id = t.track_id
      left join track_embeddings emb on emb.track_id = t.track_id
      where t.${pointer} = source_row.id and ${deviceSelectedTrackPredicate()}
    )`;
  }

  return {
    args: [...keyset.args, limit + 1],
    sql: `select ${select}
      from ${from}
      where ${predicate}${keyset.sql}
      order by ${order}
      limit ?`,
  };
}

function optionalF32(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.fround(value) : null;
}

function optionalU32(value: unknown): number | null {
  const numeric = typeof value === "bigint" ? Number(value) : value;

  return typeof numeric === "number" &&
    Number.isInteger(numeric) &&
    numeric >= 0 &&
    numeric <= UINT32_MAX
    ? numeric
    : null;
}

function sonarTrackSourceProjection(row: Record<string, unknown>): {
  payload: Record<string, JsonValue>;
  payloadBlob: Uint8Array;
} | null {
  if (!(row.embedding_blob instanceof ArrayBuffer) && !ArrayBuffer.isView(row.embedding_blob)) {
    return null;
  }

  const payloadBlob = ownedBytes(row.embedding_blob as ArrayBuffer | ArrayBufferView);

  if (payloadBlob.byteLength !== ARTIFACT_VECTOR_BYTES) {
    return null;
  }

  return {
    payload: {
      anchored: row.spotify_uri !== null,
      bpm: optionalF32(row.bpm),
      certified: row.finding_log_id !== null,
      dismissed: row.dismissed_at !== null,
      durationMs: optionalU32(row.duration_ms),
      hasFinding: row.finding_id !== null,
      isDuplicate: row.duplicate_of_track_id !== null,
      key: typeof row.key === "string" ? row.key : null,
      nearestFindingScore: optionalF32(row.nearest_finding_score),
    },
    payloadBlob,
  };
}

/**
 * Append the exact current Sonar projection after its source mutation in a caller-owned write
 * transaction. The write transaction serializes revision allocation with every other producer;
 * compacted receipts participate in the same maximum as live event bodies.
 */
export async function insertCurrentSonarTrackArtifactChangeInTransaction(
  client: Pick<Client, "execute">,
  input: { createdAt?: string; producer: string; trackId: string },
): Promise<ArtifactChangeInsertResult> {
  const sourceResult = await client.execute({
    args: [input.trackId],
    sql: `select ${SONAR_TRACK_SOURCE_COLUMNS}
      from tracks t
      left join track_embeddings e on e.track_id = t.track_id
      left join findings f on f.track_id = t.track_id
      where t.track_id = ?
      limit 1`,
  });
  const projection = sonarTrackSourceProjection(
    typedRow<Record<string, unknown>>(sourceResult.rows) ?? {},
  );
  const contract = artifactContract("sonar.track");
  const subject = { ...contract, subjectId: input.trackId, subjectType: "track" };
  const latestRevision = await latestArtifactRevisionInTransaction(client, subject);

  if (!Number.isSafeInteger(latestRevision) || latestRevision >= Number.MAX_SAFE_INTEGER) {
    apiError(
      "invalid_artifact_revision",
      "Artifact revision cannot advance beyond the positive safe-integer range",
      500,
    );
  }

  return insertArtifactChangeInTransaction(client, {
    ...subject,
    createdAt: input.createdAt,
    operation: projection === null ? "delete" : "upsert",
    payload: projection?.payload ?? {},
    payloadBlob: projection?.payloadBlob ?? null,
    producer: input.producer,
    revision: latestRevision + 1,
  });
}

async function snapshotItem(
  stream: ArtifactStream,
  row: Record<string, unknown>,
): Promise<{ cursor: string; item: ArtifactSnapshotItem }> {
  const definition = ARTIFACT_STREAM_REGISTRY[stream];
  const contract = artifactContract(stream);
  let payload: JsonValue;
  let payloadBlob: Uint8Array | null = null;
  let subjectId: string;
  let cursorValues: string[];

  if (stream === "sonar.track") {
    subjectId = String(row.track_id);
    cursorValues = [subjectId];
    const projection = sonarTrackSourceProjection(row);

    if (projection === null) {
      apiError("invalid_artifact_source", `sonar.track ${subjectId} has no vector blob`, 500);
    }

    payload = projection.payload;
    payloadBlob = projection.payloadBlob;
  } else {
    const { columns, keys } = deviceDefinition(definition);
    const devicePayload = Object.fromEntries(
      columns.map((column) => [column, jsonScalar(row[column], `${stream}.${column}`)]),
    );
    payload = devicePayload;
    subjectId = deviceSubjectId(definition, devicePayload);
    cursorValues = keys.map((key) => String(devicePayload[key]));
  }

  const payloadJson = canonicalArtifactJson(payload);
  const envelope = {
    formatVersion: contract.formatVersion,
    operation: "upsert",
    payloadJson,
    stream,
    streamVersion: contract.streamVersion,
    subjectId,
    subjectType: definition.subjectType,
  } satisfies Record<string, JsonValue>;

  return {
    cursor: encodeSnapshotCursor(cursorValues),
    item: {
      ...contract,
      operation: "upsert",
      payloadBlobBase64: payloadBlob === null ? null : artifactBytesToBase64(payloadBlob),
      payloadDigest: await payloadDigest(envelope, payloadBlob),
      payloadJson,
      subjectId,
      subjectType: definition.subjectType,
    },
  };
}

async function sourceSnapshotPage(
  client: Pick<Client, "execute">,
  contract: ArtifactContract,
  checkpoint: ArtifactRebuildCheckpoint,
  limit: number,
): Promise<Omit<ArtifactSnapshotPage, "consumerId" | "generation" | "headSeq" | "snapshotSeq">> {
  const result = await client.execute(
    buildArtifactSnapshotStatement(contract.stream, checkpoint.cursor, limit),
  );
  const rows = typedRows<Record<string, unknown>>(result.rows);
  const selected = rows.slice(0, limit);
  const mapped = await Promise.all(selected.map((row) => snapshotItem(contract.stream, row)));
  const items = mapped.map(({ item }) => item);
  const pageDigest = await extendDigest(
    EMPTY_DIGEST,
    items.map((item) => item.payloadDigest),
  );
  const sourceDigest = await extendDigest(
    checkpoint.sourceDigest,
    items.map((item) => item.payloadDigest),
  );

  return {
    ...contract,
    complete: rows.length <= limit,
    cursor: mapped.at(-1)?.cursor ?? checkpoint.cursor,
    itemCount: items.length,
    items,
    pageDigest,
    sourceDigest,
  };
}

export async function listArtifactSnapshot(
  client: ArtifactReadClient,
  input: { consumerId: string; limit?: number; stream: string; streamVersion: number },
): Promise<ArtifactSnapshotPage> {
  assertConsumerId(input.consumerId);
  const limit = input.limit ?? ARTIFACT_SNAPSHOT_LIMIT;
  assertLimit(limit, ARTIFACT_SNAPSHOT_MAX_LIMIT, "Artifact snapshot");
  const definition = registeredStream(input.stream);
  const contract = validateContract({
    formatVersion: definition.formatVersion,
    stream: input.stream,
    streamVersion: input.streamVersion,
  });
  const consumer = await readConsumer(client, input.consumerId);

  if (consumer.state !== "rebuilding") {
    apiError("artifact_consumer_not_rebuilding", "Consumer must be rebuilding", 409);
  }

  const contracts = await readContracts(client, input.consumerId);

  if (
    !contracts.some(
      (declared) =>
        declared.stream === contract.stream &&
        declared.streamVersion === contract.streamVersion &&
        declared.formatVersion === contract.formatVersion,
    )
  ) {
    apiError("unsupported_artifact_contract", "Consumer did not declare this contract", 409);
  }

  const checkpoint = await readRebuildCheckpoint(client, input.consumerId, contract);
  const headSeq = await artifactHead(client);

  if (checkpoint.state === "complete") {
    return {
      ...contract,
      complete: true,
      consumerId: input.consumerId,
      cursor: checkpoint.cursor,
      generation: checkpoint.generation,
      headSeq,
      itemCount: 0,
      items: [],
      pageDigest: EMPTY_DIGEST,
      snapshotSeq: checkpoint.snapshotSeq,
      sourceDigest: checkpoint.sourceDigest,
    };
  }

  return {
    ...(await sourceSnapshotPage(client, contract, checkpoint, limit)),
    consumerId: input.consumerId,
    generation: checkpoint.generation,
    headSeq,
    snapshotSeq: checkpoint.snapshotSeq,
  };
}

/** Re-read and durably acknowledge one exact source-snapshot page. */
export async function checkpointArtifactRebuild(
  client: ArtifactClient,
  input: {
    consumerDigest: string;
    consumerId: string;
    consumerItemCount: number;
    generation: string;
    pageDigest: string;
    pageLimit: number;
    stream: string;
    streamVersion: number;
  },
  options: { now?: string } = {},
): Promise<ArtifactRebuildCheckpoint> {
  assertConsumerId(input.consumerId);
  assertLimit(input.pageLimit, ARTIFACT_SNAPSHOT_MAX_LIMIT, "Artifact snapshot");
  hexBytes(input.consumerDigest);
  hexBytes(input.pageDigest);
  const definition = registeredStream(input.stream);
  const contract = validateContract({
    formatVersion: definition.formatVersion,
    stream: input.stream,
    streamVersion: input.streamVersion,
  });
  const now = options.now ?? new Date().toISOString();
  const transaction = await client.transaction("write");

  try {
    const consumer = await readConsumer(transaction, input.consumerId);

    if (consumer.state !== "rebuilding") {
      apiError("artifact_consumer_not_rebuilding", "Consumer must be rebuilding", 409);
    }

    const checkpoint = await readRebuildCheckpoint(transaction, input.consumerId, contract);

    if (checkpoint.state !== "running" || checkpoint.generation !== input.generation) {
      apiError("stale_artifact_rebuild", "Artifact rebuild generation is stale", 409);
    }

    const page = await sourceSnapshotPage(transaction, contract, checkpoint, input.pageLimit);
    const expectedConsumerCount = checkpoint.consumerItemCount + page.itemCount;

    if (
      page.pageDigest !== input.pageDigest ||
      page.sourceDigest !== input.consumerDigest ||
      input.consumerItemCount !== expectedConsumerCount
    ) {
      apiError(
        "stale_artifact_snapshot_page",
        "Snapshot page changed or the consumer digest/count does not match exact source bytes",
        409,
      );
    }

    const updated = await transaction.execute({
      args: [
        page.complete ? now : null,
        input.consumerDigest,
        input.consumerItemCount,
        page.cursor,
        page.sourceDigest,
        checkpoint.sourceItemCount + page.itemCount,
        page.complete ? "complete" : "running",
        now,
        input.consumerId,
        contract.stream,
        contract.streamVersion,
        input.generation,
      ],
      sql: `update artifact_change_checkpoints
        set completed_at = ?, consumer_digest = ?, consumer_item_count = ?, cursor = ?,
            source_digest = ?, source_item_count = ?, state = ?, updated_at = ?
        where consumer_id = ? and stream = ? and stream_version = ? and phase = 'rebuild'
          and generation = ? and state = 'running'
        returning completed_at, consumer_digest, consumer_item_count, cursor, generation,
                  ${contract.formatVersion} as format_version, snapshot_seq, source_digest,
                  source_item_count, started_at, state, stream, stream_version, updated_at`,
    });
    const row = typedRow<ArtifactCheckpointRow>(updated.rows);

    if (row === undefined) {
      apiError("stale_artifact_rebuild", "Artifact rebuild checkpoint raced another writer", 409);
    }

    await transaction.commit();
    return checkpointFromRow(row);
  } finally {
    transaction.close();
  }
}

/** Transition a fully snapshotted consumer to active at its original log fence. */
export async function activateArtifactConsumer(
  client: ArtifactClient,
  consumerId: string,
  options: { now?: string } = {},
): Promise<ArtifactConsumerStatus> {
  assertConsumerId(consumerId);
  const now = options.now ?? new Date().toISOString();
  const transaction = await client.transaction("write");

  try {
    const consumer = await readConsumer(transaction, consumerId);

    if (consumer.state !== "rebuilding" || consumer.snapshot_seq === null) {
      apiError("artifact_consumer_not_rebuilding", "Consumer must be rebuilding", 409);
    }

    const incomplete = await transaction.execute({
      args: [consumerId],
      sql: `select contract.stream
        from artifact_change_consumer_contracts contract
        left join artifact_change_checkpoints checkpoint
          on checkpoint.consumer_id = contract.consumer_id
         and checkpoint.stream = contract.stream
         and checkpoint.stream_version = contract.stream_version
         and checkpoint.phase = 'rebuild'
        where contract.consumer_id = ?
          and (checkpoint.state is null or checkpoint.state <> 'complete'
            or checkpoint.source_digest <> checkpoint.consumer_digest
            or checkpoint.source_item_count <> checkpoint.consumer_item_count)
        limit 1`,
    });

    if (incomplete.rows.length > 0) {
      apiError(
        "artifact_rebuild_incomplete",
        "Every declared artifact stream must finish with matching source and consumer digests",
        409,
      );
    }

    const snapshotSeq = Number(consumer.snapshot_seq);
    await transaction.execute({
      args: [snapshotSeq, now, now, now, consumerId],
      sql: `update artifact_change_consumers
        set applied_through_seq = ?, checkpointed_at = ?, state = 'active',
            state_changed_at = ?, updated_at = ?
        where consumer_id = ? and state = 'rebuilding'`,
    });
    await transaction.commit();
  } finally {
    transaction.close();
  }

  return getArtifactConsumerStatus(client, consumerId);
}

async function readChangeRows(
  client: Pick<Client, "execute">,
  afterSeq: number,
  limit: number,
): Promise<ArtifactChangeRow[]> {
  const result = await client.execute({
    args: [afterSeq, limit + 1],
    sql: `select ${ARTIFACT_CHANGE_SELECT}
      from artifact_changes
      where seq > ?
      order by seq
      limit ?`,
  });

  return typedRows<ArtifactChangeRow>(result.rows);
}

async function changesFromCheckpoint(
  client: Pick<Client, "execute">,
  consumerId: string,
  afterSeq: number,
  limit: number,
): Promise<ArtifactChangePage> {
  const contracts = await readContracts(client, consumerId);
  const rows = await readChangeRows(client, afterSeq, limit);
  const selected = rows.slice(0, limit);
  const events = await Promise.all(selected.map((row) => eventFromRow(row, contracts)));
  const headSeq = await artifactHead(client);

  return {
    batchDigest: await extendDigest(
      EMPTY_DIGEST,
      events.map((event) => event.payloadDigest),
    ),
    consumerId,
    events,
    fromSeq: afterSeq,
    hasMore: rows.length > limit,
    headSeq,
    throughSeq: events.at(-1)?.seq ?? afterSeq,
  };
}

/** Read the next bounded global-sequence page from an active consumer's durable checkpoint. */
export async function listArtifactChanges(
  client: ArtifactReadClient,
  input: { consumerId: string; limit?: number },
): Promise<ArtifactChangePage> {
  assertConsumerId(input.consumerId);
  const limit = input.limit ?? ARTIFACT_CHANGE_READ_LIMIT;
  assertLimit(limit, ARTIFACT_CHANGE_MAX_READ_LIMIT, "Artifact change");
  const consumer = await readConsumer(client, input.consumerId);

  if (consumer.state !== "active" || consumer.applied_through_seq === null) {
    apiError("artifact_consumer_not_active", "Consumer must be active", 409);
  }

  return changesFromCheckpoint(
    client,
    input.consumerId,
    Number(consumer.applied_through_seq),
    limit,
  );
}

/**
 * Acknowledge exactly the next observed page. The server re-reads and re-digests it inside the
 * write transaction, so a caller cannot regress, jump ahead, omit an event, or acknowledge an
 * unknown stream/version. A crash before this commit simply re-delivers the same page.
 */
export async function acknowledgeArtifactChanges(
  client: ArtifactClient,
  input: {
    batchDigest: string;
    consumerId: string;
    eventCount: number;
    fromSeq: number;
    throughSeq: number;
  },
  options: { now?: string } = {},
): Promise<ArtifactConsumerStatus> {
  assertConsumerId(input.consumerId);
  assertLimit(input.eventCount, ARTIFACT_CHANGE_MAX_READ_LIMIT, "Artifact acknowledgement");
  hexBytes(input.batchDigest);

  if (
    !Number.isSafeInteger(input.fromSeq) ||
    input.fromSeq < 0 ||
    !Number.isSafeInteger(input.throughSeq) ||
    input.throughSeq <= input.fromSeq
  ) {
    apiError("invalid_artifact_checkpoint", "Artifact checkpoint must move strictly forward");
  }

  const now = options.now ?? new Date().toISOString();
  const transaction = await client.transaction("write");

  try {
    const consumer = await readConsumer(transaction, input.consumerId);
    const durable =
      consumer.applied_through_seq === null ? null : Number(consumer.applied_through_seq);

    if (consumer.state !== "active" || durable === null) {
      apiError("artifact_consumer_not_active", "Consumer must be active", 409);
    }

    if (input.fromSeq !== durable) {
      apiError(
        "artifact_checkpoint_regression",
        `Checkpoint starts at ${input.fromSeq}, but durable checkpoint is ${durable}`,
        409,
      );
    }

    const page = await changesFromCheckpoint(
      transaction,
      input.consumerId,
      durable,
      input.eventCount,
    );

    if (
      page.events.length !== input.eventCount ||
      page.throughSeq !== input.throughSeq ||
      page.batchDigest !== input.batchDigest
    ) {
      apiError(
        "artifact_checkpoint_unseen",
        "Checkpoint does not identify the exact next observed artifact batch",
        409,
      );
    }

    const unknown = page.events.find((event) => !event.formatRegistered);
    if (unknown !== undefined) {
      apiError(
        "unknown_artifact_version",
        `Cannot acknowledge unregistered contract ${unknown.stream}@${unknown.streamVersion}/${unknown.formatVersion}`,
        409,
      );
    }

    const declaredStreams = new Set(
      (await readContracts(transaction, input.consumerId)).map(({ stream }) => stream),
    );
    const incompatible = page.events.find(
      (event) => declaredStreams.has(event.stream) && !event.supportedByConsumer,
    );

    if (incompatible !== undefined) {
      apiError(
        "unsupported_artifact_contract",
        `Consumer cannot acknowledge ${incompatible.stream}@${incompatible.streamVersion}/${incompatible.formatVersion}`,
        409,
      );
    }

    const updated = await transaction.execute({
      args: [input.throughSeq, now, now, input.consumerId, durable],
      sql: `update artifact_change_consumers
        set applied_through_seq = ?, checkpointed_at = ?, updated_at = ?
        where consumer_id = ? and state = 'active' and applied_through_seq = ?`,
    });

    if (updated.rowsAffected !== 1) {
      apiError(
        "artifact_checkpoint_race",
        "Artifact checkpoint raced another acknowledgement",
        409,
      );
    }

    await transaction.commit();
  } finally {
    transaction.close();
  }

  return getArtifactConsumerStatus(client, input.consumerId);
}

/** Inactive consumers retain declarations for introspection but no reusable fence/checkpoint. */
export async function inactivateArtifactConsumer(
  client: ArtifactClient,
  consumerId: string,
  options: { now?: string } = {},
): Promise<ArtifactConsumerStatus> {
  assertConsumerId(consumerId);
  const now = options.now ?? new Date().toISOString();
  const transaction = await client.transaction("write");

  try {
    await readConsumer(transaction, consumerId);
    await transaction.execute({
      args: [now, now, consumerId],
      sql: `update artifact_change_consumers
        set applied_through_seq = null, checkpointed_at = null, snapshot_seq = null,
            state = 'inactive', state_changed_at = ?, updated_at = ?
        where consumer_id = ?`,
    });
    await transaction.execute({
      args: [consumerId],
      sql: "delete from artifact_change_checkpoints where consumer_id = ?",
    });
    await transaction.commit();
  } finally {
    transaction.close();
  }

  return getArtifactConsumerStatus(client, consumerId);
}

async function compactionBarrier(client: Pick<Client, "execute">): Promise<number | null> {
  const result = await client.execute(
    `select min(case
       when state = 'active' then applied_through_seq
       when state = 'rebuilding' then snapshot_seq
       else null
     end) as barrier
     from artifact_change_consumers
     where state in ('active', 'rebuilding')`,
  );
  const barrier = typedRow<{ barrier: bigint | number | null }>(result.rows)?.barrier ?? null;

  return barrier === null ? null : Number(barrier);
}

/** Delete one bounded, transactionally barrier-checked prefix of the immutable log. */
export async function compactArtifactChanges(
  client: ArtifactClient,
  input: { limit?: number } = {},
): Promise<ArtifactCompactionResult> {
  const limit = input.limit ?? ARTIFACT_COMPACTION_MAX_LIMIT;
  assertLimit(limit, ARTIFACT_COMPACTION_MAX_LIMIT, "Artifact compaction");
  const transaction = await client.transaction("write");

  try {
    const barrier = await compactionBarrier(transaction);

    if (barrier === null) {
      await transaction.commit();
      return {
        barrier: null,
        deletedCount: 0,
        deletedFromSeq: null,
        deletedThroughSeq: null,
        reason: "no_safe_barrier",
      };
    }

    const candidates = await transaction.execute({
      args: [barrier, limit],
      sql: `select seq from artifact_changes where seq <= ? order by seq limit ?`,
    });
    const sequences = candidates.rows.map((row) => Number(row.seq));
    const first = sequences[0];
    const last = sequences.at(-1);

    if (first === undefined || last === undefined) {
      await transaction.commit();
      return {
        barrier,
        deletedCount: 0,
        deletedFromSeq: null,
        deletedThroughSeq: null,
        reason: "empty",
      };
    }

    const deleted = await transaction.execute({
      args: [first, last, barrier],
      sql: `delete from artifact_changes
        where seq >= ? and seq <= ? and seq <= ?
        returning seq`,
    });
    const deletedSeqs = deleted.rows
      .map((row) => Number(row.seq))
      .sort((left, right) => left - right);

    if (
      deletedSeqs.length !== sequences.length ||
      deletedSeqs.some((sequence, index) => sequence !== sequences[index])
    ) {
      apiError("artifact_compaction_race", "Artifact compaction range changed in transaction", 409);
    }

    await transaction.commit();
    return {
      barrier,
      deletedCount: deletedSeqs.length,
      deletedFromSeq: deletedSeqs[0] ?? null,
      deletedThroughSeq: deletedSeqs.at(-1) ?? null,
      reason: "compacted",
    };
  } finally {
    transaction.close();
  }
}

export async function getArtifactConsumerStatus(
  client: ArtifactReadClient,
  consumerId: string,
): Promise<ArtifactConsumerStatus> {
  assertConsumerId(consumerId);
  const consumer = await readConsumer(client, consumerId);
  const [contracts, checkpointResult, boundsResult, headSeq, barrier] = await Promise.all([
    readContracts(client, consumerId),
    client.execute({
      args: [consumerId],
      sql: `select checkpoint.completed_at, checkpoint.consumer_digest,
                   checkpoint.consumer_item_count, checkpoint.cursor, checkpoint.generation,
                   contract.format_version, checkpoint.snapshot_seq, checkpoint.source_digest,
                   checkpoint.source_item_count, checkpoint.started_at, checkpoint.state,
                   checkpoint.stream, checkpoint.stream_version, checkpoint.updated_at
        from artifact_change_checkpoints checkpoint
        join artifact_change_consumer_contracts contract
          on contract.consumer_id = checkpoint.consumer_id
         and contract.stream = checkpoint.stream
         and contract.stream_version = checkpoint.stream_version
        where checkpoint.consumer_id = ? and checkpoint.phase = 'rebuild'
        order by checkpoint.stream, checkpoint.stream_version`,
    }),
    client.execute("select min(seq) as earliest_seq from artifact_changes"),
    artifactHead(client),
    compactionBarrier(client),
  ]);
  const earliest =
    typedRow<{ earliest_seq: bigint | number | null }>(boundsResult.rows)?.earliest_seq ?? null;

  return {
    appliedThroughSeq:
      consumer.applied_through_seq === null ? null : Number(consumer.applied_through_seq),
    checkpointedAt: consumer.checkpointed_at,
    compactionBarrier: barrier,
    consumerId: consumer.consumer_id,
    contracts,
    earliestSeq: earliest === null ? null : Number(earliest),
    headSeq,
    rebuilds: typedRows<ArtifactCheckpointRow>(checkpointResult.rows).map(checkpointFromRow),
    registeredAt: consumer.registered_at,
    snapshotSeq: consumer.snapshot_seq === null ? null : Number(consumer.snapshot_seq),
    state: consumer.state,
    stateChangedAt: consumer.state_changed_at,
    updatedAt: consumer.updated_at,
  };
}

export async function registerArtifactConsumerLive(input: {
  consumerId: string;
  contracts: readonly ArtifactContract[];
}): Promise<ArtifactConsumerStatus> {
  return registerArtifactConsumer(await getDb(), input);
}

export async function listArtifactSnapshotLive(input: {
  consumerId: string;
  limit?: number;
  stream: string;
  streamVersion: number;
}): Promise<ArtifactSnapshotPage> {
  return listArtifactSnapshot(await getDb(), input);
}

export async function checkpointArtifactRebuildLive(
  input: Parameters<typeof checkpointArtifactRebuild>[1],
): Promise<ArtifactRebuildCheckpoint> {
  return checkpointArtifactRebuild(await getDb(), input);
}

export async function activateArtifactConsumerLive(
  consumerId: string,
): Promise<ArtifactConsumerStatus> {
  return activateArtifactConsumer(await getDb(), consumerId);
}

export async function listArtifactChangesLive(input: {
  consumerId: string;
  limit?: number;
}): Promise<ArtifactChangePage> {
  return listArtifactChanges(await getDb(), input);
}

export async function acknowledgeArtifactChangesLive(
  input: Parameters<typeof acknowledgeArtifactChanges>[1],
): Promise<ArtifactConsumerStatus> {
  return acknowledgeArtifactChanges(await getDb(), input);
}

export async function inactivateArtifactConsumerLive(
  consumerId: string,
): Promise<ArtifactConsumerStatus> {
  return inactivateArtifactConsumer(await getDb(), consumerId);
}

export async function getArtifactConsumerStatusLive(
  consumerId: string,
): Promise<ArtifactConsumerStatus> {
  return getArtifactConsumerStatus(await getDb(), consumerId);
}

export async function compactArtifactChangesLive(input: {
  limit?: number;
}): Promise<ArtifactCompactionResult> {
  return compactArtifactChanges(await getDb(), input);
}

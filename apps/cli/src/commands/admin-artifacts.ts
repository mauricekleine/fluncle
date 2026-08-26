// `fluncle admin artifacts` is the thin authenticated transport for filesystemful derived-artifact
// consumers. The Worker owns registry validation, source snapshots, fences, ordering, digests,
// lifecycle, and compaction; this module only serializes the exact protocol messages.

import {
  ARTIFACT_CHANGE_API_MAX_LIMIT,
  ARTIFACT_COMPACTION_API_MAX_LIMIT,
  ARTIFACT_SNAPSHOT_API_MAX_LIMIT,
  ARTIFACT_SUPPORTED_CONTRACTS,
  type ArtifactChangePage,
  type ArtifactCompactionResult,
  type ArtifactConsumerStatus,
  type ArtifactContract,
  type ArtifactRebuildCheckpoint,
  type ArtifactSnapshotPage,
  type ArtifactStream,
} from "@fluncle/contracts/orpc";
import { adminApiGet, adminApiPost } from "../api";

type ConsumerResponse = {
  consumer: ArtifactConsumerStatus;
  ok: true;
};

type RebuildCheckpointResponse = {
  checkpoint: ArtifactRebuildCheckpoint;
  ok: true;
};

function consumerPath(consumerId: string): string {
  return `/api/v1/admin/artifacts/consumers/${encodeURIComponent(consumerId)}`;
}

export {
  ARTIFACT_CHANGE_API_MAX_LIMIT,
  ARTIFACT_COMPACTION_API_MAX_LIMIT,
  ARTIFACT_SNAPSHOT_API_MAX_LIMIT,
};

export function parseArtifactContracts(values: string[]): ArtifactContract[] {
  if (values.length === 0) {
    throw new Error("At least one --contract is required");
  }

  const supported = new Map(
    ARTIFACT_SUPPORTED_CONTRACTS.map((contract) => [
      `${contract.stream}@${contract.streamVersion}/${contract.formatVersion}`,
      contract,
    ]),
  );
  const contracts = values.map((value) => {
    const contract = supported.get(value);

    if (contract === undefined) {
      throw new Error(
        `Unsupported artifact contract ${JSON.stringify(value)}; expected one of: ${[...supported.keys()].join(", ")}`,
      );
    }

    return { ...contract };
  });

  if (new Set(values).size !== values.length) {
    throw new Error("Artifact contracts must be unique");
  }

  return contracts;
}

export function parseArtifactStream(value: string): ArtifactStream {
  const stream = ARTIFACT_SUPPORTED_CONTRACTS.find((contract) => contract.stream === value)?.stream;

  if (stream === undefined) {
    throw new Error(
      `Unsupported artifact stream ${JSON.stringify(value)}; expected one of: ${ARTIFACT_SUPPORTED_CONTRACTS.map((contract) => contract.stream).join(", ")}`,
    );
  }

  return stream;
}

export function parseArtifactInteger(
  value: string,
  flag: string,
  options: { maximum?: number; minimum?: number } = {},
): number {
  const parsed = Number(value);
  const minimum = options.minimum ?? 1;

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    (options.maximum !== undefined && parsed > options.maximum)
  ) {
    const range =
      options.maximum === undefined
        ? `at least ${minimum}`
        : `between ${minimum} and ${options.maximum}`;
    throw new Error(`${flag} must be a safe integer ${range}`);
  }

  return parsed;
}

export async function registerArtifactConsumerCommand(input: {
  consumerId: string;
  contracts: ArtifactContract[];
}): Promise<ConsumerResponse> {
  return adminApiPost<ConsumerResponse>("/api/v1/admin/artifacts/consumers", input);
}

export async function getArtifactConsumerCommand(consumerId: string): Promise<ConsumerResponse> {
  return adminApiGet<ConsumerResponse>(consumerPath(consumerId));
}

export async function listArtifactSnapshotCommand(input: {
  consumerId: string;
  limit: number;
  stream: ArtifactStream;
  streamVersion: number;
}): Promise<ArtifactSnapshotPage> {
  const params = new URLSearchParams({
    consumerId: input.consumerId,
    limit: String(input.limit),
    stream: input.stream,
    streamVersion: String(input.streamVersion),
  });

  return adminApiGet<ArtifactSnapshotPage>(
    `/api/v1/admin/artifacts/snapshots?${params.toString()}`,
  );
}

export async function checkpointArtifactRebuildCommand(input: {
  consumerDigest: string;
  consumerId: string;
  consumerItemCount: number;
  generation: string;
  pageDigest: string;
  pageLimit: number;
  stream: ArtifactStream;
  streamVersion: number;
}): Promise<RebuildCheckpointResponse> {
  return adminApiPost<RebuildCheckpointResponse>(
    `${consumerPath(input.consumerId)}/rebuilds/${encodeURIComponent(input.stream)}/checkpoint`,
    input,
  );
}

export async function activateArtifactConsumerCommand(
  consumerId: string,
): Promise<ConsumerResponse> {
  return adminApiPost<ConsumerResponse>(`${consumerPath(consumerId)}/activate`, { consumerId });
}

export async function listArtifactChangesCommand(input: {
  consumerId: string;
  limit: number;
}): Promise<ArtifactChangePage> {
  const params = new URLSearchParams({
    consumerId: input.consumerId,
    limit: String(input.limit),
  });

  return adminApiGet<ArtifactChangePage>(`/api/v1/admin/artifacts/changes?${params.toString()}`);
}

export async function acknowledgeArtifactChangesCommand(input: {
  batchDigest: string;
  consumerId: string;
  eventCount: number;
  fromSeq: number;
  throughSeq: number;
}): Promise<ConsumerResponse> {
  return adminApiPost<ConsumerResponse>(`${consumerPath(input.consumerId)}/checkpoint`, input);
}

export async function inactivateArtifactConsumerCommand(
  consumerId: string,
): Promise<ConsumerResponse> {
  return adminApiPost<ConsumerResponse>(`${consumerPath(consumerId)}/inactivate`, { consumerId });
}

export async function compactArtifactChangesCommand(
  limit: number,
): Promise<ArtifactCompactionResult> {
  return adminApiPost<ArtifactCompactionResult>("/api/v1/admin/artifacts/changes/compact", {
    limit,
  });
}

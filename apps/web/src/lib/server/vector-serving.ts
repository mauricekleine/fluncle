import { type ArtifactConsumerStatus } from "@fluncle/contracts/orpc";

import { getArtifactConsumerStatusLive } from "./artifact-changes";
import {
  isSonarTrackEnabled,
  readSonarHealth,
  setSonarTrackEnabled,
  SONAR_DELTA_CADENCE_SECS,
  SONAR_RECONCILE_CADENCE_SECS,
  type SonarHealth,
} from "./sonar";
import { ApiError } from "./spotify";

const SONAR_ARTIFACT_VERSION = "sonar.track@1/1";
const SONAR_STREAM = "sonar.track";
const FRESHNESS_GRACE_MULTIPLIER = 3;
const DELTA_STALE_SECS = SONAR_DELTA_CADENCE_SECS * FRESHNESS_GRACE_MULTIPLIER;
const REPLICA_STALE_SECS = SONAR_RECONCILE_CADENCE_SECS * FRESHNESS_GRACE_MULTIPLIER;

export type VectorServingReason =
  | "artifact_contract_mismatch"
  | "checkpoint_mismatch"
  | "consumer_contract_mismatch"
  | "consumer_not_active"
  | "consumer_rebuild_incomplete"
  | "consumer_unavailable"
  | "delta_stale"
  | "empty_index"
  | "pending_ack"
  | "producer_backlog"
  | "replica_stale"
  | "sonar_not_ok"
  | "sonar_unavailable"
  | "build_identity_missing"
  | "validation_failed";

export type VectorServingStatus = {
  commissioning: { ready: boolean; reasons: VectorServingReason[] };
  enabled: boolean;
  evidence: {
    artifactVersion: string | null;
    checkpoint: number | null;
    checkpointedAt: string | null;
    commit: string | null;
    consumerAppliedThroughSeq: number | null;
    consumerHeadSeq: number | null;
    consumerId: string | null;
    consumerState: ArtifactConsumerStatus["state"] | null;
    deltaAgeSeconds: number | null;
    deltaBacklog: number | null;
    pendingAck: boolean | null;
    replicaLagSeconds: number | null;
    tracks: number | null;
    validation: SonarHealth["validation"] | null;
  };
  runtime: { ready: boolean; reasons: VectorServingReason[] };
  target: "tracks";
};

type AssessmentInput = {
  consumer: ArtifactConsumerStatus | null;
  enabled: boolean;
  health: SonarHealth | null;
  nowMs?: number;
};

function add(reasons: VectorServingReason[], reason: VectorServingReason): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

/** Derive first-open and steady-state readiness from bounded control-plane evidence. */
export function assessVectorServing(input: AssessmentInput): VectorServingStatus {
  const health = input.health;
  const consumer = input.consumer;
  const healthAssessment = healthReasons(health);
  const commissioning = healthAssessment.commissioning;
  const runtime = healthAssessment.runtime;
  const consumerAssessment = consumerReasons(consumer, health, input.nowMs ?? Date.now());

  for (const reason of consumerAssessment.commissioning) {
    add(commissioning, reason);
  }
  for (const reason of consumerAssessment.runtime) {
    add(runtime, reason);
  }

  return {
    commissioning: { ready: commissioning.length === 0, reasons: commissioning },
    enabled: input.enabled,
    evidence: servingEvidence(health, consumer),
    runtime: { ready: runtime.length === 0, reasons: runtime },
    target: "tracks",
  };
}

function servingEvidence(
  health: SonarHealth | null,
  consumer: ArtifactConsumerStatus | null,
): VectorServingStatus["evidence"] {
  return {
    artifactVersion: health?.artifactVersion ?? null,
    checkpoint: health?.checkpoint ?? null,
    checkpointedAt: consumer?.checkpointedAt ?? null,
    commit: health?.commit ?? null,
    consumerAppliedThroughSeq: consumer?.appliedThroughSeq ?? null,
    consumerHeadSeq: consumer?.headSeq ?? null,
    consumerId: health?.consumerId ?? null,
    consumerState: consumer?.state ?? null,
    deltaAgeSeconds: health?.deltaAgeSeconds ?? null,
    deltaBacklog: health?.deltaBacklog ?? null,
    pendingAck: health?.pendingAck ?? null,
    replicaLagSeconds: health?.replicaLagSeconds ?? null,
    tracks: health?.tracks ?? null,
    validation: health?.validation ?? null,
  };
}

function healthReasons(health: SonarHealth | null): {
  commissioning: VectorServingReason[];
  runtime: VectorServingReason[];
} {
  const commissioning: VectorServingReason[] = [];
  const runtime: VectorServingReason[] = [];
  const both = (reason: VectorServingReason) => {
    add(commissioning, reason);
    add(runtime, reason);
  };
  if (!health) {
    return { commissioning: ["sonar_unavailable"], runtime: ["sonar_unavailable"] };
  }
  if (!health.ok) {
    both("sonar_not_ok");
  }
  if (health.tracks === 0) {
    both("empty_index");
  }
  if (!/^[0-9a-f]{40}$/.test(health.commit)) {
    add(commissioning, "build_identity_missing");
  }
  if (health.artifactVersion !== SONAR_ARTIFACT_VERSION) {
    both("artifact_contract_mismatch");
  }
  if (health.validation !== "valid") {
    both("validation_failed");
  }
  if (health.pendingAck) {
    add(commissioning, "pending_ack");
  }
  if (health.replicaLagSeconds < 0 || health.replicaLagSeconds > REPLICA_STALE_SECS) {
    both("replica_stale");
  }
  if (health.deltaBacklog > 0 && health.deltaAgeSeconds > DELTA_STALE_SECS) {
    both("delta_stale");
  }
  return { commissioning, runtime };
}

function consumerReasons(
  consumer: ArtifactConsumerStatus | null,
  health: SonarHealth | null,
  nowMs: number,
): { commissioning: VectorServingReason[]; runtime: VectorServingReason[] } {
  const commissioning: VectorServingReason[] = [];
  const runtime: VectorServingReason[] = [];
  const both = (reason: VectorServingReason) => {
    add(commissioning, reason);
    add(runtime, reason);
  };
  if (!consumer) {
    both("consumer_unavailable");
    return { commissioning, runtime };
  }
  if (consumer.state !== "active") {
    both("consumer_not_active");
  }
  const contractReady = consumer.contracts.some(
    (contract) =>
      contract.stream === SONAR_STREAM &&
      contract.streamVersion === 1 &&
      contract.formatVersion === 1,
  );
  if (!contractReady) {
    both("consumer_contract_mismatch");
  }
  const rebuild = consumer.rebuilds.find(
    (candidate) => candidate.stream === SONAR_STREAM && candidate.streamVersion === 1,
  );
  if (!rebuild || rebuild.state !== "complete") {
    both("consumer_rebuild_incomplete");
  }
  if (
    !health ||
    consumer.appliedThroughSeq === null ||
    consumer.appliedThroughSeq !== health.checkpoint
  ) {
    add(commissioning, "checkpoint_mismatch");
  }
  if (!health || consumer.headSeq !== health.checkpoint) {
    add(commissioning, "producer_backlog");
  }
  if (
    health &&
    consumer.headSeq > health.checkpoint &&
    checkpointAgeSeconds(consumer.checkpointedAt, nowMs) > DELTA_STALE_SECS
  ) {
    add(runtime, "delta_stale");
  }
  return { commissioning, runtime };
}

function checkpointAgeSeconds(value: string | null, nowMs: number): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.floor((nowMs - timestamp) / 1000))
    : Number.POSITIVE_INFINITY;
}

export async function getVectorServingStatus(): Promise<VectorServingStatus> {
  const [enabled, health] = await Promise.all([isSonarTrackEnabled(), readSonarHealth()]);
  let consumer: ArtifactConsumerStatus | null = null;

  if (health) {
    try {
      consumer = await getArtifactConsumerStatusLive(health.consumerId);
    } catch {
      consumer = null;
    }
  }

  return assessVectorServing({ consumer, enabled, health });
}

export async function setVectorServing(enabled: boolean): Promise<VectorServingStatus> {
  const currentlyEnabled = await isSonarTrackEnabled();

  if (!enabled) {
    await setSonarTrackEnabled(false);
    return getVectorServingStatus();
  }

  if (currentlyEnabled) {
    return getVectorServingStatus();
  }

  const status = await getVectorServingStatus();

  if (!status.commissioning.ready) {
    throw new ApiError(
      "vector_serving_not_ready",
      `Track vector serving is not ready: ${status.commissioning.reasons.join(", ")}`,
      409,
    );
  }

  await setSonarTrackEnabled(true);
  return { ...status, enabled: true };
}

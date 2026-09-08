import { type VectorServingStatus } from "@fluncle/contracts/orpc";

import { adminApiGet, adminApiPut } from "../api";

export type VectorTarget = "tracks";
export type VectorServingResponse = { ok: true; status: VectorServingStatus };

export async function getVectorServingCommand(
  target: VectorTarget,
): Promise<VectorServingResponse> {
  return adminApiGet<VectorServingResponse>(`/api/v1/admin/vectors/${target}/serving`);
}

export async function setVectorServingCommand(input: {
  enabled: boolean;
  target: VectorTarget;
}): Promise<VectorServingResponse> {
  return adminApiPut<VectorServingResponse>(`/api/v1/admin/vectors/${input.target}/serving`, {
    enabled: input.enabled,
  });
}

export function parseVectorTarget(value: string): VectorTarget {
  if (value !== "tracks") {
    throw new Error("target must be tracks");
  }
  return value;
}

export function parseVectorEnabled(value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error("--enabled must be true or false");
  }
  return value === "true";
}

export function vectorServingStatusLines(status: VectorServingStatus): string[] {
  const reasons = (label: string, values: string[]) =>
    values.length === 0 ? `${label}: ready.` : `${label}: ${values.join(", ")}.`;

  return [
    `tracks: ${status.enabled ? "enabled" : "disabled"}.`,
    reasons("commissioning", status.commissioning.reasons),
    reasons("runtime", status.runtime.reasons),
  ];
}

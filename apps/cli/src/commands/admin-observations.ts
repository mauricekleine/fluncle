import {
  type ObservationGate,
  type ObservationRejection,
  type ObservationRejectionsResponse,
} from "@fluncle/contracts";
import { adminApiGet, adminApiPatch } from "../api";

export type { ObservationGate, ObservationRejection };

type ObservationGateResponse = { gate: ObservationGate };

export async function observationHeldCommand(options: {
  settled?: boolean;
}): Promise<ObservationRejectionsResponse> {
  const query = options.settled ? "?open=false" : "";

  return adminApiGet<ObservationRejectionsResponse>(`/api/v1/admin/observation-rejections${query}`);
}

export async function observationGateCommand(options: {
  maxOverlap?: number;
  minPhraseWords?: number;
}): Promise<ObservationGate> {
  const patch: Record<string, number> = {};

  if (options.minPhraseWords !== undefined) {
    patch.minPhraseWords = options.minPhraseWords;
  }

  if (options.maxOverlap !== undefined) {
    patch.maxOverlap = options.maxOverlap;
  }

  if (Object.keys(patch).length === 0) {
    const response = await adminApiGet<ObservationRejectionsResponse>(
      "/api/v1/admin/observation-rejections",
    );

    return response.gate;
  }

  const response = await adminApiPatch<ObservationGateResponse>(
    "/api/v1/admin/observation-gate",
    patch,
  );

  return response.gate;
}

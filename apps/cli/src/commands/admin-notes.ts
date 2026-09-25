import { type NoteGate, type NoteRejection, type NoteRejectionsResponse } from "@fluncle/contracts";
import { adminApiGet, adminApiPatch } from "../api";

export type { NoteGate, NoteRejection };

type NoteGateResponse = { gate: NoteGate };

export async function noteHeldCommand(options: {
  settled?: boolean;
}): Promise<NoteRejectionsResponse> {
  const query = options.settled ? "?open=false" : "";

  return adminApiGet<NoteRejectionsResponse>(`/api/v1/admin/note-rejections${query}`);
}

export async function noteGateCommand(options: {
  maxOverlap?: number;
  minPhraseWords?: number;
}): Promise<NoteGate> {
  const patch: Record<string, number> = {};

  if (options.minPhraseWords !== undefined) {
    patch.minPhraseWords = options.minPhraseWords;
  }

  if (options.maxOverlap !== undefined) {
    patch.maxOverlap = options.maxOverlap;
  }

  if (Object.keys(patch).length === 0) {
    const response = await adminApiGet<NoteRejectionsResponse>("/api/v1/admin/note-rejections");

    return response.gate;
  }

  const response = await adminApiPatch<NoteGateResponse>("/api/v1/admin/note-gate", patch);

  return response.gate;
}

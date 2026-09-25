import { FOUND_BASE } from "../media";

export async function readCaptions(logIds: string[]): Promise<Record<string, string>> {
  if (logIds.length === 0) {
    return {};
  }

  const entries = await Promise.all(
    logIds.map(async (logId) => {
      try {
        const response = await fetch(`${FOUND_BASE}/${encodeURIComponent(logId)}/note.txt`);
        const text = response.ok ? (await response.text()).trim() : "";

        return [logId, text] as const;
      } catch {
        return [logId, ""] as const;
      }
    }),
  );

  const captions: Record<string, string> = {};

  for (const [logId, text] of entries) {
    if (text) {
      captions[logId] = text;
    }
  }

  return captions;
}

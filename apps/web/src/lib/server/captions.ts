import { FOUND_BASE } from "../media";

/**
 * Read bundle captions (`note.txt`) for findings, keyed by Log ID — one fetch
 * per id, in parallel. We read the PUBLIC R2 URL rather than the `VIDEOS`
 * binding so it works in local dev too (the dev binding is an empty local
 * bucket; the bundles live in the real bucket behind found.fluncle.com).
 *
 * The admin board preloads these so the operator can copy a caption in a single
 * tap: a clipboard write must be synchronous inside the tap on iOS, so the text
 * has to be in hand before the click, not fetched after it. Missing/empty → omitted.
 */
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

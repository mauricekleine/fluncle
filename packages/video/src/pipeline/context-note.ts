// Read a finding's distilled `context_note` and surface it into the render props
// as CREATIVE FUEL (direction, never on-screen text).
//
// The context note is the third enrichment artifact's first half — firecrawl FACTS
// distilled by a small LLM (apps/web/src/lib/server/observation.ts): 1–2 dry
// paragraphs of scene/label/release context, ending in one `Texture: ` line of
// 3–6 sensory/scene/mood pointers (e.g. "orchestrated, layered, expansive,
// atmospheric depth"). The features summary says HOW a track sounds (centroid,
// busyness); the Texture says WHAT it evokes. The video agent reads both at
// concept time to steer the vehicle, texture family, palette lean, and scene.
//
// The note is INTERNAL (admin-gated), not on the public /api/tracks, so we read it
// the same way the observe sweep does — `fluncle admin tracks context <id> --json`
// returns the stored note (`skipped: true`, NO re-fetch) for a finding that already
// has one. Best-effort throughout: a missing CLI, an un-context'd finding, or any
// read failure degrades to NO fuel (exactly as `track.features` is absent on
// un-enriched tracks), never blocking the render.

import { spawnSync } from "node:child_process";

/** The `fluncle` CLI binary; overridable for non-PATH installs (mirrors observe-sweep). */
const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

export type ContextNote = {
  /** The full distilled note (prose + the trailing `Texture:` line), as stored. */
  contextNote: string;
  /**
   * The pointers parsed out of the trailing `Texture: ` line — the most direct
   * creative fuel for the video. Empty when the note has no Texture line.
   */
  texture: string[];
};

/**
 * Split the trailing `Texture: ` line out of a distilled context note.
 *
 * The distil prompt ends the note with exactly one line beginning `Texture: `
 * carrying 3–6 comma-separated pointers. We find the LAST such line (robust to a
 * stray earlier mention), parse its comma list into trimmed, de-duplicated
 * pointers, and return both the untouched full note and those pointers. A note
 * without a Texture line yields an empty `texture` array — graceful, not an error.
 */
export function parseContextNote(rawNote: string): ContextNote {
  const contextNote = rawNote.trim();

  if (!contextNote) {
    return { contextNote: "", texture: [] };
  }

  // Find the last line that begins (after optional whitespace) with `Texture:`.
  const lines = contextNote.split(/\r?\n/);
  let textureLine: string | undefined;

  for (const line of lines) {
    if (/^\s*texture:/i.test(line)) {
      textureLine = line;
    }
  }

  if (!textureLine) {
    return { contextNote, texture: [] };
  }

  const afterLabel = textureLine.replace(/^\s*texture:\s*/i, "");
  const seen = new Set<string>();
  const texture: string[] = [];

  for (const raw of afterLabel.split(",")) {
    const pointer = raw.trim().replace(/\.$/, "").trim();
    const key = pointer.toLowerCase();

    if (pointer && !seen.has(key)) {
      seen.add(key);
      texture.push(pointer);
    }
  }

  return { contextNote, texture };
}

/**
 * Read a finding's stored context note via the admin CLI and parse out its Texture
 * pointers. Returns `undefined` when there is no fuel to surface: the CLI is
 * missing, the read failed, the finding has no note, or the note is blank. The
 * caller spreads the result onto `track` only when present, so an un-context'd
 * finding produces the same props it always did.
 */
export function readContextNote(idOrLogId: string): ContextNote | undefined {
  let result: { code: number; stderr: string; stdout: string };

  try {
    const spawned = spawnSync(FLUNCLE_BIN, ["admin", "tracks", "context", idOrLogId, "--json"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });

    if (spawned.error) {
      // The CLI binary isn't on PATH (e.g. a bare `packages/video` checkout) — no
      // fuel, not a failure. The note is optional, like `features`.
      return undefined;
    }

    result = {
      code: spawned.status ?? 1,
      stderr: spawned.stderr ?? "",
      stdout: spawned.stdout ?? "",
    };
  } catch {
    return undefined;
  }

  if (result.code !== 0) {
    return undefined;
  }

  let payload: { contextNote?: string };

  try {
    payload = JSON.parse(result.stdout) as { contextNote?: string };
  } catch {
    return undefined;
  }

  const parsed = parseContextNote(payload.contextNote ?? "");

  return parsed.contextNote ? parsed : undefined;
}

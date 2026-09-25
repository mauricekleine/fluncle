import { spawnSync } from "node:child_process";

import { fluncleBin, fluncleSpawnEnv } from "./fluncle-bin";

export type ContextNote = {
  contextNote: string;

  texture: string[];
};

export function parseContextNote(rawNote: string): ContextNote {
  const contextNote = rawNote.trim();

  if (!contextNote) {
    return { contextNote: "", texture: [] };
  }

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

export function readContextNote(idOrLogId: string): ContextNote | undefined {
  let result: { code: number; stderr: string; stdout: string };

  try {
    const spawned = spawnSync(fluncleBin(), ["admin", "tracks", "context", idOrLogId, "--json"], {
      encoding: "utf8",
      env: fluncleSpawnEnv(),
      maxBuffer: 8 * 1024 * 1024,
    });

    if (spawned.error) {
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

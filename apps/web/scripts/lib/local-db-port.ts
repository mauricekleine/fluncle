import { createHash } from "node:crypto";

export function portForWorktree(directory: string): number {
  const hash = createHash("sha256").update(directory).digest();

  return 8100 + (hash.readUInt16BE(0) % 900);
}

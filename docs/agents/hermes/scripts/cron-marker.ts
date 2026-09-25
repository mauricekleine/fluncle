export const STDERR_DELIMITER = "<!-- fluncle-cron-output: stderr tail -->";

export function splitMarker(body: string): { stderr: string; stdout: string } {
  const index = body.indexOf(STDERR_DELIMITER);
  return index < 0
    ? { stderr: "", stdout: body }
    : { stderr: body.slice(index + STDERR_DELIMITER.length), stdout: body.slice(0, index) };
}

export function findJsonSummary(body: string): Record<string, unknown> | null {
  const lines = splitMarker(body)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return null;
}

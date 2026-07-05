// Pre-flight token parsing for the run drawer. Show pre-flight lines are
// parseable canon — `[clear] / [hold] / [dark]` (packages/live/src/show.ts) —
// and the drawer renders them as status rows, not raw text. Pure and tested.

export type StatusToken = "clear" | "dark" | "hold";

export type StatusRow = {
  /** The check's name (the padded column before the note), or the whole line. */
  label: string;
  /** The check's note — empty when the line was a single sentence. */
  note: string;
  token: StatusToken;
};

const TOKEN_RE = /^\s*\[(clear|hold|dark)\]\s+(\S.*)$/;

/**
 * Read one output line as a pre-flight status row, or undefined for a plain log
 * line. show.ts frames rows as `  [token] label.padEnd(22) note`, so a 2+-space
 * gap splits label from note; a token followed by a plain sentence keeps the
 * whole sentence as the label.
 */
export function parseStatusLine(text: string): StatusRow | undefined {
  const match = TOKEN_RE.exec(text);
  const token = match?.[1];
  const rest = match?.[2];

  if (token === undefined || rest === undefined) {
    return undefined;
  }

  const gap = rest.search(/\s{2,}/);

  if (gap === -1) {
    return { label: rest.trim(), note: "", token: token as StatusToken };
  }

  return {
    label: rest.slice(0, gap).trim(),
    note: rest.slice(gap).trim(),
    token: token as StatusToken,
  };
}

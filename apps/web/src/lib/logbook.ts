// Fluncle's Logbook — the client-safe prose model shared by the public pages
// (/logbook, /logbook/<sector>) and the parser test. PURE: no server deps, so it
// imports cleanly into the browser bundle.
//
// The BODY is markdown-lite: blank-line-separated paragraphs, `##`/`###` headings,
// `**bold**` / `*italic*` inline emphasis, and — the load-bearing bit — the FIGURE
// TOKEN. A line that is exactly `[[<logId>]]` (a finding's coordinate) is not prose:
// it marks where the finding's poster image is inlined as a real "photo" of
// Fluncle's day. `parseLogbookBody` turns the body into a flat block list the page
// renders; the page swaps each `figure` block for the finding's poster + caption
// ("Artist — Title · <logId>") linking to /log/<logId>.
//
// SECURITY: the parser only ever emits TEXT (plain strings + a validated logId) — it
// never carries raw HTML through, so the page renders every segment as a React text
// node and there is no injection sink. Unknown/garbled inline markup degrades to
// literal text rather than being interpreted.

import { formatSector } from "./log-id-shared";
import { artistTitleLine } from "./log-prose";
import { trackMedia } from "./media";

// A logId inside a figure token: the sector digits, dots, and alphanumerics that make
// up a coordinate (e.g. `036.7.2I`, `019.F.1A`). Anchored so only a line that is
// SOLELY the token (ignoring surrounding whitespace) becomes a figure.
const FIGURE_TOKEN_RE = /^\[\[([A-Za-z0-9.]+)\]\]$/;
const HEADING_RE = /^(#{2,3})\s+(.+)$/;

/** One inline run of body prose — plain text or emphasized. */
export type LogbookInline =
  | { text: string; type: "text" }
  | { text: string; type: "strong" }
  | { text: string; type: "em" };

/** One rendered block of a logbook entry body. */
export type LogbookBlock =
  | { content: LogbookInline[]; level: 2 | 3; type: "heading" }
  | { content: LogbookInline[]; type: "paragraph" }
  | { logId: string; type: "figure" };

/**
 * Parse a logbook body into an ordered block list. Blank lines separate paragraphs;
 * a line that is exactly `[[<logId>]]` becomes a `figure` block; `##`/`###` lines
 * become headings; every other run of consecutive non-blank lines is a paragraph
 * (soft-wrapped lines are joined with a space, the markdown convention).
 */
export function parseLogbookBody(body: string): LogbookBlock[] {
  const blocks: LogbookBlock[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ content: parseInline(paragraphLines.join(" ")), type: "paragraph" });
      paragraphLines = [];
    }
  };

  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();

    if (line === "") {
      flushParagraph();
      continue;
    }

    const figure = FIGURE_TOKEN_RE.exec(line);
    if (figure?.[1]) {
      flushParagraph();
      blocks.push({ logId: figure[1], type: "figure" });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading?.[1] && heading[2]) {
      flushParagraph();
      blocks.push({
        content: parseInline(heading[2]),
        level: heading[1].length === 3 ? 3 : 2,
        type: "heading",
      });
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return blocks;
}

// Inline emphasis: `**strong**` and `*em*`. A tiny hand tokenizer (no dependency) —
// the body is quiet prose, so bold/italic is the whole inline surface. Unbalanced
// markers stay literal (the scan only splits on a matched pair).
const INLINE_RE = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/g;

function parseInline(text: string): LogbookInline[] {
  const segments: LogbookInline[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;

    if (index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, index), type: "text" });
    }

    if (match[2] !== undefined) {
      segments.push({ text: match[2], type: "strong" });
    } else if (match[3] !== undefined) {
      segments.push({ text: match[3], type: "em" });
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), type: "text" });
  }

  return segments.length > 0 ? segments : [{ text, type: "text" }];
}

/** The finding metadata a figure caption needs, keyed by Log ID (from the day's findings). */
export type LogbookFigureFinding = { artists: string[]; title: string };

export type LogbookFigure = {
  /** "Artist — Title · <logId>", or the bare coordinate when the finding is unknown. */
  caption: string;
  logId: string;
  /** The finding's poster "photo" on found.fluncle.com. */
  posterUrl: string;
};

/**
 * Resolve a figure token's logId into its poster URL + caption, using the day's
 * findings map. An unknown logId (a finding since removed, or an off-day reference)
 * still renders — the poster URL derives from the coordinate and the caption falls
 * back to the bare Log ID — so a stale token degrades gracefully instead of breaking
 * the page.
 */
export function resolveLogbookFigure(
  logId: string,
  findings: Record<string, LogbookFigureFinding>,
): LogbookFigure {
  const finding = findings[logId];
  const caption = finding ? `${artistTitleLine(finding)} · ${logId}` : logId;

  return { caption, logId, posterUrl: trackMedia(logId).posterUrl };
}

/** The public path for a sector's logbook entry (`/logbook/036`). */
export function logbookPath(sector: number): string {
  return `/logbook/${formatSector(sector)}`;
}

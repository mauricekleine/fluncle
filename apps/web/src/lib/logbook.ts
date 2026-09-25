import { formatSector } from "./log-id-shared";
import { artistTitleLine } from "./log-prose";
import { trackMedia } from "./media";

const FIGURE_TOKEN_RE = /^\[\[([A-Za-z0-9.]+)\]\]$/;
const HEADING_RE = /^(#{2,3})\s+(.+)$/;

export type LogbookInline =
  | { text: string; type: "text" }
  | { text: string; type: "strong" }
  | { text: string; type: "em" };

export type LogbookBlock =
  | { content: LogbookInline[]; level: 2 | 3; type: "heading" }
  | { content: LogbookInline[]; type: "paragraph" }
  | { logId: string; type: "figure" };

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

export type LogbookFigureFinding = { artists: string[]; title: string };

export type LogbookFigure = {
  caption: string;
  logId: string;

  posterUrl: string;
};

export function resolveLogbookFigure(
  logId: string,
  findings: Record<string, LogbookFigureFinding>,
): LogbookFigure {
  const finding = findings[logId];
  const caption = finding ? `${artistTitleLine(finding)} · ${logId}` : logId;

  return { caption, logId, posterUrl: trackMedia(logId).posterUrl };
}

export function logbookPath(sector: number): string {
  return `/logbook/${formatSector(sector)}`;
}

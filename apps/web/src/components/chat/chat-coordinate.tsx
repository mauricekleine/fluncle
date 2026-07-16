import { HoverCard, HoverCardContent, HoverCardTrigger } from "@fluncle/ui/components/hover-card";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentPropsWithoutRef, type ReactNode, useState } from "react";
import { type ChatFinding, FindingCard } from "@/components/chat/finding-card";
import { type KeyNotation } from "@/lib/key-notation";
import { isLogId, isMixtapeLogId } from "@/lib/log-id";
import { cn } from "@/lib/utils";

// THE CHAT COORDINATE — a Log ID named in chat prose becomes the same kind of citizen a
// graph name is (components/graph-link.tsx, DESIGN.md "Graph Link"): a quiet link wearing a
// hover card. When Fluncle writes "The one that got me was Let's Leave Tomorrow (012.4.4D)",
// the coordinate links to its log page and a deliberate pause over it shows the Finding Card —
// the same card the tool outputs render, so a coordinate reads identically whether a tool
// surfaced it or the uncle just said it.
//
// ── THE CARD'S DATA IS USUALLY ALREADY ON THE TRANSCRIPT ────────────────────────────
// Chat prose almost always names coordinates its tool calls just returned, and those tool
// outputs carry the FULL finding (preview flag, duration, note). The renderer hands this
// component the transcript's findings-by-coordinate map, so the common case costs zero
// requests. Only a coordinate the model names WITHOUT having dug it (rare) falls back to a
// lazy fetch — through the search op's coordinate tier, which resolves a bare Log ID straight
// to its finding. Same laziness discipline as GraphLink: fetch on OPEN, never on render.
//
// ── SCANNING IS SINGLE-SOURCED ON THE CANONICAL GRAMMAR ─────────────────────────────
// The scan regex below is deliberately LOOSE (it only finds coordinate-shaped runs); every
// candidate is then confirmed against `isLogId` / `isMixtapeLogId` from the shared grammar
// (@fluncle/contracts/log-id), so the accept/reject rules live in exactly one place. A mixtape
// coordinate links to its log page but carries no card — the Finding Card is finding-shaped.

const OPEN_DELAY_MS = 450;
const CLOSE_DELAY_MS = 200;

/**
 * A coordinate-shaped run inside prose: 3-4 digits, dot, the galaxy slot (digit or the mixtape
 * F), dot, digit + mark — fenced so `1012.4.4D` or `012.4.4DX` never half-matches. Loose by
 * design; `isLogId`/`isMixtapeLogId` make the actual call per candidate.
 */
const COORDINATE_SCAN = /(?<![\d.A-Z])(\d{3,4}\.[\dF]\.\d[A-Z])(?![\dA-Z])/g;

export type ChatTextSegment =
  | { kind: "coordinate"; logId: string; mixtape: boolean }
  | { kind: "text"; text: string };

/** Split prose into plain runs and confirmed coordinates. Pure — the testable half. */
export function splitOnCoordinates(text: string): ChatTextSegment[] {
  const segments: ChatTextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(COORDINATE_SCAN)) {
    const candidate = match[1] ?? "";
    const finding = isLogId(candidate);
    const mixtape = isMixtapeLogId(candidate);

    if (!finding && !mixtape) {
      continue;
    }

    if (match.index > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    }

    segments.push({ kind: "coordinate", logId: candidate, mixtape });
    cursor = match.index + candidate.length;
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }

  return segments;
}

/**
 * The fallback resolve, through the search op's coordinate tier (docs/search.md tier 1: a bare
 * Log ID resolves straight to the finding it names). The hit is the lean search projection —
 * no preview flag, no duration — so a fallback card carries fewer chips than a transcript one;
 * honest, and still the cover + identity + coordinate the pause was asking for.
 */
async function fetchCoordinateFinding(logId: string): Promise<ChatFinding> {
  const response = await fetch(`/api/v1/search/archive?q=${encodeURIComponent(logId)}`);

  if (!response.ok) {
    throw new Error(`No record at ${logId}`);
  }

  const body = (await response.json()) as {
    results?: {
      albumImageUrl?: string;
      artists?: string[];
      bpm?: number;
      galaxy?: string;
      key?: string;
      logId?: string;
      title?: string;
    }[];
  };
  const hit = body.results?.find((row) => row.logId === logId);

  if (!hit) {
    throw new Error(`No record at ${logId}`);
  }

  return {
    albumImageUrl: hit.albumImageUrl,
    artists: hit.artists,
    bpm: hit.bpm,
    coordinate: hit.logId,
    galaxy: hit.galaxy,
    key: hit.key,
    title: hit.title,
  };
}

/**
 * `...anchorProps` is LOAD-BEARING (graph-link.tsx's EntityAnchor precedent): base-ui's
 * `render` prop hands this element the trigger's hover/focus handlers, the ref, and the ARIA.
 * Drop the spread and the link looks perfect but no card ever opens behind it.
 */
function CoordinateAnchor({
  logId,
  ...anchorProps
}: { logId: string } & ComponentPropsWithoutRef<"a">) {
  return (
    <Link
      {...anchorProps}
      className={cn("graph-link chat-coordinate", anchorProps.className)}
      params={{ logId }}
      to="/log/$logId"
    >
      {logId}
    </Link>
  );
}

function ChatCoordinate({
  finding,
  logId,
  notation,
}: {
  finding?: ChatFinding;
  logId: string;
  notation: KeyNotation;
}) {
  const [open, setOpen] = useState(false);

  // Lazy, keyed by the coordinate, shared across every mention of it on the transcript — and
  // skipped entirely when the transcript already carries the finding (the common case).
  const { data, isError } = useQuery({
    enabled: open && !finding,
    gcTime: 30 * 60_000,
    queryFn: () => fetchCoordinateFinding(logId),
    queryKey: ["chat-coordinate", logId],
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const resolved = finding ?? data;

  return (
    <HoverCard onOpenChange={setOpen} open={open}>
      <HoverCardTrigger
        closeDelay={CLOSE_DELAY_MS}
        delay={OPEN_DELAY_MS}
        render={<CoordinateAnchor logId={logId} />}
      />
      <HoverCardContent className="graph-card" side="top">
        {resolved ? (
          <FindingCard embedded finding={resolved} notation={notation} />
        ) : (
          <p className="text-xs text-muted-foreground">
            {isError ? "Nothing at this coordinate." : "Pulling the record…"}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Prose → React nodes: every confirmed coordinate becomes a link, findings wearing the hover
 * card, mixtapes a plain link (no finding-shaped card to show). Plain runs pass through as
 * strings, so `whitespace-pre-wrap` keeps doing the line work.
 */
export function linkifyCoordinates(
  text: string,
  findingsByLogId: ReadonlyMap<string, ChatFinding>,
  notation: KeyNotation,
): ReactNode {
  const segments = splitOnCoordinates(text);

  if (segments.length === 1 && segments[0]?.kind === "text") {
    return text;
  }

  return segments.map((segment, index) =>
    segment.kind === "text" ? (
      segment.text
    ) : segment.mixtape ? (
      // oxlint-disable-next-line no-array-index-key -- static split of one string, never reordered
      <CoordinateAnchor key={index} logId={segment.logId} />
    ) : (
      <ChatCoordinate
        // oxlint-disable-next-line no-array-index-key -- static split of one string, never reordered
        key={index}
        finding={findingsByLogId.get(segment.logId)}
        logId={segment.logId}
        notation={notation}
      />
    ),
  );
}

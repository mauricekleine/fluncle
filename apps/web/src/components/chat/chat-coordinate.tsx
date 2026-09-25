import { HoverCard, HoverCardContent, HoverCardTrigger } from "@fluncle/ui/components/hover-card";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentPropsWithoutRef, type ReactNode, useState } from "react";
import { type ChatFinding, FindingCard } from "@/components/chat/finding-card";
import { type KeyNotation } from "@/lib/key-notation";
import { isLogId, isMixtapeLogId } from "@/lib/log-id";
import { cn } from "@/lib/utils";

const OPEN_DELAY_MS = 450;
const CLOSE_DELAY_MS = 200;

const COORDINATE_SCAN = /(?<![\d.A-Z])(\d{3,4}\.[\dF]\.\d[A-Z])(?![\dA-Z])/g;

export type ChatTextSegment =
  | { kind: "coordinate"; logId: string; mixtape: boolean }
  | { kind: "text"; text: string };

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
      <CoordinateAnchor key={index} logId={segment.logId} />
    ) : (
      <ChatCoordinate
        key={index}
        finding={findingsByLogId.get(segment.logId)}
        logId={segment.logId}
        notation={notation}
      />
    ),
  );
}

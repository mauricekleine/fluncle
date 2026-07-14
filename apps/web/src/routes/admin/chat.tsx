import { useChat } from "@ai-sdk/react";
import {
  ArrowUpIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import { type FormEvent, Fragment, type ReactNode, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { ArtistCard, type ChatArtist } from "@/components/chat/artist-card";
import { ChainCard, type ChatSet } from "@/components/chat/chain-card";
import { type ChatFinding, FindingCard } from "@/components/chat/finding-card";
import { FindingList } from "@/components/chat/finding-list";
import { type ChatLabel, LabelCard } from "@/components/chat/label-card";
import { type ChatMixtape, MixtapeCard } from "@/components/chat/mixtape-card";
import { type ChatStatus, StatusStrip } from "@/components/chat/status-strip";
import { MixPreviewBar } from "@/components/mix/mix-preview-bar";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { type FluncleUIMessage } from "@/lib/server/chat";
import { Bubble, BubbleContent } from "@fluncle/ui/components/bubble";
import { Button } from "@fluncle/ui/components/button";
import { Marker, MarkerContent, MarkerIcon } from "@fluncle/ui/components/marker";
import { Message, MessageContent } from "@fluncle/ui/components/message";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@fluncle/ui/components/message-scroller";
import { Textarea } from "@fluncle/ui/components/textarea";

// ── ChatDnB — the workbench (a PRIVATE, admin-gated SPIKE) ─────────────────────────────
//
// Deliberately BARE: an input, the streamed reply, and — the point of the spike — the tool
// calls shown INLINE in the transcript, so the operator watches the grounding work happen.
// Not a SaaS chat window (PRODUCT.md bans the streaming-app clone by name); it is a quiet,
// dark admin station like every other one, built on the shell chrome + the shadcn chat
// components. The engine (the grounding prompt, the archive tools, the UIMessage stream) is
// lib/server/chat.ts; this page rides `useChat` — the transport speaks the AI SDK UIMessage
// protocol, so tool parts arrive typed and this page only renders them and posts a turn.
// History stays EPHEMERAL: `useChat`'s in-memory messages, no persistence.

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

export const Route = createFileRoute("/admin/chat")({
  beforeLoad: () => ensureAdmin(),
  component: ChatWorkbench,
});

function ChatWorkbench() {
  const [draft, setDraft] = useState("");
  const { notation } = useKeyNotation();
  const { error, messages, sendMessage, status } = useChat<FluncleUIMessage>({
    transport: new DefaultChatTransport({ api: "/api/admin/chat" }),
  });
  // "submitted" is the gap between posting a turn and the first streamed chunk.
  const busy = status === "submitted" || status === "streaming";

  // Every finding on the transcript, deduped by coordinate — the persistent now-playing bar's
  // row set, so a preview started from any card gets the same bottom bar the rest of the app has.
  const previewRows = useMemo(() => collectPreviewRows(messages), [messages]);

  function send(event: FormEvent) {
    event.preventDefault();

    const content = draft.trim();

    if (!content || busy) {
      return;
    }

    setDraft("");
    void sendMessage({ text: content });
  }

  return (
    <AdminShell subtitle="Fluncle answers over his own archive" title="ChatDnB">
      <div className="flex min-h-0 flex-1 flex-col">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport className="px-3 py-4 sm:px-4">
              <MessageScrollerContent className="mx-auto flex w-full max-w-2xl flex-col gap-4">
                {messages.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    Ask Fluncle something. He answers from the archive or he says he hasn't been
                    there.
                  </p>
                ) : undefined}

                {messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                  >
                    <Message align={message.role === "user" ? "end" : "start"}>
                      <MessageContent>{renderParts(message, notation)}</MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}

                {busy ? (
                  <p className="animate-pulse px-1 text-xs text-muted-foreground">
                    Fluncle is digging…
                  </p>
                ) : undefined}

                {error ? (
                  <Marker variant="border" role="alert">
                    <MarkerIcon>
                      <WarningCircleIcon className="text-destructive" />
                    </MarkerIcon>
                    <MarkerContent className="text-destructive">{error.message}</MarkerContent>
                  </Marker>
                ) : undefined}
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>

        <form
          className="mx-auto flex w-full max-w-2xl shrink-0 items-end gap-2 border-t border-border px-3 py-3 sm:px-4"
          onSubmit={send}
        >
          <Textarea
            className="max-h-40 min-h-10 resize-none"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(event);
              }
            }}
            placeholder="What have you found on Hospital Records?"
            rows={1}
            value={draft}
          />
          <Button
            aria-label="Send"
            disabled={busy || draft.trim().length === 0}
            size="icon"
            type="submit"
          >
            <ArrowUpIcon />
          </Button>
        </form>
      </div>

      {/* The persistent now-playing bar (portals to document.body): renders null unless a
          preview is actually playing, so it costs nothing until a card starts one. */}
      <MixPreviewBar notation={notation} tracks={previewRows} />
    </AdminShell>
  );
}

// Render a message's parts: user + assistant text as bubbles, every tool step as a visible
// marker (the grounding work) — and, when a tool returns findings, the real Finding Cards in
// place of the raw JSON output marker. Text bubbles read muted for the assistant, primary for
// the crew. A tool part carries its whole lifecycle in one part, so the call marker renders from
// the moment the input streams; while the dig is underway a skeleton card stands in for the
// future output, and the cards (or the summarize fallback) join once the output arrives.
// `step-start` and any other part types are workbench noise and render nothing.
function renderParts(message: FluncleUIMessage, notation: KeyNotation): ReactNode {
  return message.parts.map((part, index) => {
    const key = `${message.id}-${index}`;

    if (part.type === "text") {
      return (
        <Bubble
          key={key}
          align={message.role === "user" ? "end" : "start"}
          variant={message.role === "user" ? "default" : "muted"}
        >
          <BubbleContent className="whitespace-pre-wrap">{part.text}</BubbleContent>
        </Bubble>
      );
    }

    if (isToolUIPart(part)) {
      const name = getToolName(part);
      // KEEP the call marker exactly as-is — watching the grounding work happen is the point of
      // the workbench. The cards REPLACE only the raw `→ {json}` output marker.
      const call = (
        <Marker variant="separator">
          <MarkerIcon>
            {name === "search_archive" ? <MagnifyingGlassIcon /> : <WrenchIcon />}
          </MarkerIcon>
          <MarkerContent>
            <span className="font-medium text-foreground">{name}</span>
            <span className="text-muted-foreground"> · {summarize(part.input)}</span>
          </MarkerContent>
        </Marker>
      );

      if (part.state === "output-available") {
        const cards = renderFindingOutput(part.output, notation);

        return (
          <Fragment key={key}>
            {call}
            {cards ?? (
              <Marker variant="border">
                <MarkerContent className="font-mono text-xs text-muted-foreground">
                  → {summarize(part.output)}
                </MarkerContent>
              </Marker>
            )}
          </Fragment>
        );
      }

      if (part.state === "output-error") {
        return (
          <Fragment key={key}>
            {call}
            <Marker variant="border" role="alert">
              <MarkerIcon>
                <WarningCircleIcon className="text-destructive" />
              </MarkerIcon>
              <MarkerContent className="text-destructive">
                {name}: {part.errorText}
              </MarkerContent>
            </Marker>
          </Fragment>
        );
      }

      // input-streaming / input-available — the dig is underway; a skeleton card stands in for
      // the finding it is about to hand back, under the same call marker.
      return (
        <Fragment key={key}>
          {call}
          <SkeletonCard />
        </Fragment>
      );
    }

    return undefined;
  });
}

// A tool output rendered as its card (a finding, a list, an artist, a label, a chain, a mixtape,
// or the status strip), or `undefined` for the shapes no card owns (a not-found, an empty result)
// — the caller keeps the plain summarize marker for those (and, unchanged, the error marker for
// output-error). Structural, so one branch covers each shape regardless of the tool name.
function renderFindingOutput(output: unknown, notation: KeyNotation): ReactNode {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }

  if ("set" in output && output.set) {
    return <ChainCard notation={notation} set={output.set as ChatSet} />;
  }

  if ("artist" in output && output.artist) {
    return <ArtistCard artist={output.artist as ChatArtist} notation={notation} />;
  }

  if ("label" in output && output.label) {
    return <LabelCard label={output.label as ChatLabel} notation={notation} />;
  }

  if ("mixtape" in output && output.mixtape) {
    return <MixtapeCard mixtape={output.mixtape as ChatMixtape} />;
  }

  // get_status → the compact one-line strip (structural, like every other branch).
  if ("headline" in output && output.headline) {
    return <StatusStrip status={output as ChatStatus} />;
  }

  if ("finding" in output && output.finding) {
    return <FindingCard finding={output.finding as ChatFinding} notation={notation} />;
  }

  if ("findings" in output && Array.isArray(output.findings) && output.findings.length > 0) {
    const anchor = "anchor" in output && output.anchor ? (output.anchor as ChatFinding) : undefined;

    return (
      <div className="flex flex-col gap-2">
        {anchor ? (
          <>
            <p className="px-1 text-xs text-muted-foreground">Anchored on</p>
            <FindingCard finding={anchor} notation={notation} />
          </>
        ) : null}
        <FindingList findings={output.findings as ChatFinding[]} notation={notation} />
      </div>
    );
  }

  return undefined;
}

// The "dig underway" placeholder: one artwork square + two text lines, sized to a Finding Card so
// the layout does not jump when the real card arrives.
function SkeletonCard(): ReactNode {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <Skeleton className="size-[3.25rem] shrink-0 rounded-[var(--rounded-artwork)]" />
      <div className="min-w-0 flex-1 space-y-2 py-1">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

// Every finding visible on the transcript, deduped by coordinate — the now-playing bar's rows.
// Reads the same tool outputs the cards render from, so the bar and the cards agree on what is
// previewable. Only findings with a coordinate (the relay key) can ever be the active row.
function collectPreviewRows(messages: FluncleUIMessage[]): {
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  key?: string;
  logId?: string;
  title: string;
}[] {
  const byLogId = new Map<
    string,
    {
      albumImageUrl?: string;
      artists: string[];
      bpm?: number;
      key?: string;
      logId: string;
      title: string;
    }
  >();

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part) || part.state !== "output-available") {
        continue;
      }

      const output = part.output;

      if (typeof output !== "object" || output === null) {
        continue;
      }

      const findings: ChatFinding[] = [];

      if ("finding" in output && output.finding) {
        findings.push(output.finding as ChatFinding);
      }
      if ("anchor" in output && output.anchor) {
        findings.push(output.anchor as ChatFinding);
      }
      if ("findings" in output && Array.isArray(output.findings)) {
        findings.push(...(output.findings as ChatFinding[]));
      }
      // A chain card nests its seed + steps one level down — both are previewable certified
      // findings, so the now-playing bar reaches them the same as a top-level result set.
      if ("set" in output && output.set && typeof output.set === "object") {
        const set = output.set as { seed?: ChatFinding; steps?: ChatFinding[] };

        if (set.seed) {
          findings.push(set.seed);
        }
        if (Array.isArray(set.steps)) {
          findings.push(...set.steps);
        }
      }

      // An artist/label card nests its entity's findings one level down — they are previewable
      // too, so the now-playing bar reaches them the same as a top-level result set.
      for (const entityKey of ["artist", "label"] as const) {
        const entity =
          entityKey in output
            ? (output as Record<string, { findings?: unknown }>)[entityKey]
            : undefined;

        if (entity && Array.isArray(entity.findings)) {
          findings.push(...(entity.findings as ChatFinding[]));
        }
      }

      for (const finding of findings) {
        if (finding.coordinate && !byLogId.has(finding.coordinate)) {
          byLogId.set(finding.coordinate, {
            albumImageUrl: finding.albumImageUrl,
            artists: finding.artists ?? [],
            bpm: finding.bpm,
            key: finding.key,
            logId: finding.coordinate,
            title: finding.title ?? "",
          });
        }
      }
    }
  }

  return [...byLogId.values()];
}

// A one-line, readable digest of a tool input/output for the transcript (never the raw
// pretty-printed blob — this is a workbench log line, not a debugger).
function summarize(value: unknown): string {
  const json = JSON.stringify(value ?? {});

  return json.length > 240 ? `${json.slice(0, 240)}…` : json;
}

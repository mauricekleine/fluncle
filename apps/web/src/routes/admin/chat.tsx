import {
  ArrowUpIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { type ChatMessage, type TranscriptEvent } from "@/lib/server/chat";
import { Bubble, BubbleContent } from "@fluncle/ui/components/bubble";
import { Button } from "@fluncle/ui/components/button";
import { Marker, MarkerContent, MarkerIcon } from "@fluncle/ui/components/marker";
import { Message, MessageContent } from "@fluncle/ui/components/message";
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
// components. The engine (the grounding prompt, the archive tools, the NDJSON stream) is
// lib/server/chat.ts; this page only renders the transcript and posts a turn.

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

export const Route = createFileRoute("/admin/chat")({
  beforeLoad: () => ensureAdmin(),
  component: ChatWorkbench,
});

// One rendered block within a turn: a run of text, or a visible tool step.
type Block =
  | { kind: "text"; text: string }
  | { input: unknown; kind: "tool-call"; name: string }
  | { kind: "tool-result"; name: string; output: unknown }
  | { error: string; kind: "tool-error"; name?: string }
  | { error: string; kind: "error" };

type Turn = { blocks: Block[]; id: string; role: "assistant" | "user" };

function ChatWorkbench() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // The plain-text history the model is grounded on across turns (role + final text only).
  const historyRef = useRef<ChatMessage[]>([]);

  async function send(event: FormEvent) {
    event.preventDefault();

    const content = draft.trim();

    if (!content || streaming) {
      return;
    }

    setDraft("");
    setError(undefined);

    const userTurn: Turn = {
      blocks: [{ kind: "text", text: content }],
      id: turnId(),
      role: "user",
    };
    const assistantTurn: Turn = { blocks: [], id: turnId(), role: "assistant" };

    setTurns((prev) => [...prev, userTurn, assistantTurn]);
    historyRef.current = [...historyRef.current, { content, role: "user" }];
    setStreaming(true);

    try {
      const response = await fetch("/api/admin/chat", {
        body: JSON.stringify({ messages: historyRef.current }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok || !response.body) {
        setError(await readError(response));
        return;
      }

      await consumeTranscript(response.body, (transcriptEvent) => {
        applyEvent(setTurns, assistantTurn.id, transcriptEvent);
      });

      // Fold the assistant's final text back into the grounded history for the next turn.
      setTurns((prev) => {
        const finished = prev.find((turn) => turn.id === assistantTurn.id);
        historyRef.current = [
          ...historyRef.current,
          { content: finished ? assistantText(finished) : "", role: "assistant" },
        ];
        return prev;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStreaming(false);
    }
  }

  return (
    <AdminShell subtitle="Fluncle answers over his own archive" title="ChatDnB">
      <div className="flex min-h-0 flex-1 flex-col">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport className="px-3 py-4 sm:px-4">
              <MessageScrollerContent className="mx-auto flex w-full max-w-2xl flex-col gap-4">
                {turns.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    Ask Fluncle something. He answers from the archive or he says he hasn't been
                    there.
                  </p>
                ) : undefined}

                {turns.map((turn) => (
                  <MessageScrollerItem
                    key={turn.id}
                    messageId={turn.id}
                    scrollAnchor={turn.role === "user"}
                  >
                    <Message align={turn.role === "user" ? "end" : "start"}>
                      <MessageContent>{renderBlocks(turn)}</MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}

                {streaming ? (
                  <p className="animate-pulse px-1 text-xs text-muted-foreground">
                    Fluncle is digging…
                  </p>
                ) : undefined}

                {error ? (
                  <Marker variant="border" role="status">
                    <MarkerIcon>
                      <WarningCircleIcon className="text-destructive" />
                    </MarkerIcon>
                    <MarkerContent className="text-destructive">{error}</MarkerContent>
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
            disabled={streaming}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(event);
              }
            }}
            placeholder="What have you found on Hospital Records?"
            rows={1}
            value={draft}
          />
          <Button
            aria-label="Send"
            disabled={streaming || draft.trim().length === 0}
            size="icon"
            type="submit"
          >
            <ArrowUpIcon />
          </Button>
        </form>
      </div>
    </AdminShell>
  );
}

// Render a turn's blocks: user + assistant text as bubbles, every tool step as a visible
// marker (the grounding work). Text bubbles read muted for the assistant, primary for the crew.
function renderBlocks(turn: Turn): ReactNode {
  return turn.blocks.map((block, index) => {
    const key = `${turn.id}-${index}`;

    if (block.kind === "text") {
      return (
        <Bubble
          key={key}
          align={turn.role === "user" ? "end" : "start"}
          variant={turn.role === "user" ? "default" : "muted"}
        >
          <BubbleContent className="whitespace-pre-wrap">{block.text}</BubbleContent>
        </Bubble>
      );
    }

    if (block.kind === "tool-call") {
      return (
        <Marker key={key} variant="separator">
          <MarkerIcon>
            {block.name === "search_archive" ? <MagnifyingGlassIcon /> : <WrenchIcon />}
          </MarkerIcon>
          <MarkerContent>
            <span className="font-medium text-foreground">{block.name}</span>
            <span className="text-muted-foreground"> · {summarize(block.input)}</span>
          </MarkerContent>
        </Marker>
      );
    }

    if (block.kind === "tool-result") {
      return (
        <Marker key={key} variant="border">
          <MarkerContent className="font-mono text-xs text-muted-foreground">
            → {summarize(block.output)}
          </MarkerContent>
        </Marker>
      );
    }

    const message =
      block.kind === "tool-error" ? `${block.name ?? "tool"}: ${block.error}` : block.error;

    return (
      <Marker key={key} variant="border" role="status">
        <MarkerIcon>
          <WarningCircleIcon className="text-destructive" />
        </MarkerIcon>
        <MarkerContent className="text-destructive">{message}</MarkerContent>
      </Marker>
    );
  });
}

// A one-line, readable digest of a tool input/output for the transcript (never the raw
// pretty-printed blob — this is a workbench log line, not a debugger).
function summarize(value: unknown): string {
  const json = JSON.stringify(value ?? {});

  return json.length > 240 ? `${json.slice(0, 240)}…` : json;
}

function assistantText(turn: Turn): string {
  return turn.blocks
    .filter((block): block is { kind: "text"; text: string } => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

// Fold one transcript event into the assistant turn: text streams onto the trailing text
// block (a new one after a tool step), tool steps append as their own blocks.
function applyEvent(
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>,
  assistantId: string,
  event: TranscriptEvent,
): void {
  if (event.type === "done") {
    return;
  }

  setTurns((prev) =>
    prev.map((turn) => {
      if (turn.id !== assistantId) {
        return turn;
      }

      return { ...turn, blocks: appendEvent(turn.blocks, event) };
    }),
  );
}

function appendEvent(blocks: Block[], event: TranscriptEvent): Block[] {
  if (event.type === "text") {
    const last = blocks.at(-1);

    if (last?.kind === "text") {
      return [...blocks.slice(0, -1), { kind: "text", text: last.text + event.text }];
    }

    return [...blocks, { kind: "text", text: event.text }];
  }

  if (event.type === "tool-call") {
    return [...blocks, { input: event.input, kind: "tool-call", name: event.name }];
  }

  if (event.type === "tool-result") {
    return [...blocks, { kind: "tool-result", name: event.name, output: event.output }];
  }

  if (event.type === "tool-error") {
    return [...blocks, { error: event.error, kind: "tool-error", name: event.name }];
  }

  if (event.type === "error") {
    return [...blocks, { error: event.error, kind: "error" }];
  }

  // "done" carries no block (applyEvent handles it earlier); leave the transcript untouched.
  return blocks;
}

// Read the NDJSON stream line by line, handing each parsed transcript event to the sink.
async function consumeTranscript(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: TranscriptEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseLine(line);

      if (event) {
        onEvent(event);
      }
    }
  }

  const tail = parseLine(buffer);

  if (tail) {
    onEvent(tail);
  }
}

function parseLine(line: string): TranscriptEvent | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as TranscriptEvent;
  } catch {
    return null;
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };

    return body.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

let counter = 0;
function turnId(): string {
  counter += 1;

  return `turn-${counter}`;
}

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
import { type FormEvent, Fragment, type ReactNode, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { type FluncleUIMessage } from "@/lib/server/chat";
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
  const { error, messages, sendMessage, status } = useChat<FluncleUIMessage>({
    transport: new DefaultChatTransport({ api: "/api/admin/chat" }),
  });
  // "submitted" is the gap between posting a turn and the first streamed chunk.
  const busy = status === "submitted" || status === "streaming";

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
                      <MessageContent>{renderParts(message)}</MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}

                {busy ? (
                  <p className="animate-pulse px-1 text-xs text-muted-foreground">
                    Fluncle is digging…
                  </p>
                ) : undefined}

                {error ? (
                  <Marker variant="border" role="status">
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
    </AdminShell>
  );
}

// Render a message's parts: user + assistant text as bubbles, every tool step as a visible
// marker (the grounding work). Text bubbles read muted for the assistant, primary for the
// crew. A tool part carries its whole lifecycle in one part, so the call marker renders from
// the moment the input streams and the result (or error) marker joins it once the state says
// so. `step-start` and any other part types are workbench noise and render nothing.
function renderParts(message: FluncleUIMessage): ReactNode {
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
        return (
          <Fragment key={key}>
            {call}
            <Marker variant="border">
              <MarkerContent className="font-mono text-xs text-muted-foreground">
                → {summarize(part.output)}
              </MarkerContent>
            </Marker>
          </Fragment>
        );
      }

      if (part.state === "output-error") {
        return (
          <Fragment key={key}>
            {call}
            <Marker variant="border" role="status">
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

      // input-streaming / input-available — the dig is underway; the call marker is enough.
      return <Fragment key={key}>{call}</Fragment>;
    }

    return undefined;
  });
}

// A one-line, readable digest of a tool input/output for the transcript (never the raw
// pretty-printed blob — this is a workbench log line, not a debugger).
function summarize(value: unknown): string {
  const json = JSON.stringify(value ?? {});

  return json.length > 240 ? `${json.slice(0, 240)}…` : json;
}

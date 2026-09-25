import { useChat } from "@ai-sdk/react";
import {
  ArrowUpIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import { type FormEvent, Fragment, type ReactNode, useMemo, useState } from "react";
import { ArtistCard, type ChatArtist } from "@/components/chat/artist-card";
import { CatalogueList } from "@/components/chat/catalogue-card";
import { ChainCard, type ChatSet } from "@/components/chat/chain-card";
import { collectChatFindings, planListOutput } from "@/components/chat/chat-output";
import { linkifyCoordinates } from "@/components/chat/chat-coordinate";
import { type ChatFinding, FindingCard } from "@/components/chat/finding-card";
import { FindingList } from "@/components/chat/finding-list";
import { type ChatLabel, LabelCard } from "@/components/chat/label-card";
import { type ChatMixtape, MixtapeCard } from "@/components/chat/mixtape-card";
import { type ChatNeighbour, NeighbourList } from "@/components/chat/neighbour-card";
import { type ChatStatus, StatusStrip } from "@/components/chat/status-strip";
import { MixPreviewBar } from "@/components/mix/mix-preview-bar";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
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

const DEFAULT_EMPTY_STATE =
  "Ask Fluncle something. He answers from the archive or he says he hasn't been there.";
const DEFAULT_PLACEHOLDER = "What have you found on Hospital Records?";

export function ChatConversation({
  csrfToken,
  emptyState = DEFAULT_EMPTY_STATE,
  placeholder = DEFAULT_PLACEHOLDER,
  transportApi,
}: {
  csrfToken?: string;

  emptyState?: ReactNode;

  placeholder?: string;

  transportApi: string;
}) {
  const [draft, setDraft] = useState("");
  const { notation } = useKeyNotation();

  const transport = useMemo(
    () =>
      new DefaultChatTransport<FluncleUIMessage>({
        api: transportApi,
        headers: csrfToken ? { "x-fluncle-csrf": csrfToken } : undefined,
      }),
    [transportApi, csrfToken],
  );
  const { error, messages, sendMessage, status } = useChat<FluncleUIMessage>({ transport });

  const busy = status === "submitted" || status === "streaming";

  const findingsByLogId = useMemo(() => collectChatFindings(messages), [messages]);
  const previewRows = useMemo(() => toPreviewRows(findingsByLogId), [findingsByLogId]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-3 py-4 sm:px-4">
            <MessageScrollerContent className="mx-auto flex w-full max-w-2xl flex-col gap-4">
              {messages.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">{emptyState}</p>
              ) : undefined}

              {messages.map((message) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                >
                  <Message align={message.role === "user" ? "end" : "start"}>
                    <MessageContent>
                      {renderParts(message, notation, findingsByLogId)}
                    </MessageContent>
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
          placeholder={placeholder}
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

      <MixPreviewBar notation={notation} tracks={previewRows} />
    </div>
  );
}

function renderParts(
  message: FluncleUIMessage,
  notation: KeyNotation,
  findingsByLogId: ReadonlyMap<string, ChatFinding>,
): ReactNode {
  return message.parts.map((part, index) => {
    const key = `${message.id}-${index}`;

    if (part.type === "text") {
      return (
        <Bubble
          key={key}
          align={message.role === "user" ? "end" : "start"}
          variant={message.role === "user" ? "default" : "muted"}
        >
          <BubbleContent className="whitespace-pre-wrap">
            {message.role === "assistant"
              ? linkifyCoordinates(part.text, findingsByLogId, notation)
              : part.text}
          </BubbleContent>
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

  if ("similar" in output && Array.isArray(output.similar)) {
    return (
      <NeighbourList
        neighbours={output.similar as ChatNeighbour[]}
        of={(output as { of?: { name?: string; slug?: string } }).of}
      />
    );
  }

  if ("mixtape" in output && output.mixtape) {
    return <MixtapeCard mixtape={output.mixtape as ChatMixtape} />;
  }

  if ("headline" in output && output.headline) {
    return <StatusStrip status={output as ChatStatus} />;
  }

  if ("finding" in output && output.finding) {
    return <FindingCard finding={output.finding as ChatFinding} notation={notation} />;
  }

  const plan = planListOutput(output);

  if (plan) {
    return (
      <div className="flex flex-col gap-2">
        {plan.anchor ? (
          <>
            <p className="px-1 text-xs text-muted-foreground">Anchored on</p>
            <FindingCard finding={plan.anchor} notation={notation} />
          </>
        ) : null}
        {plan.findings.length > 0 ? (
          <FindingList findings={plan.findings} notation={notation} />
        ) : null}
        {plan.catalogue.length > 0 ? (
          <CatalogueList catalogue={plan.catalogue} heading={plan.catalogueHeading} />
        ) : null}
      </div>
    );
  }

  return undefined;
}

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

function toPreviewRows(findingsByLogId: ReadonlyMap<string, ChatFinding>): {
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  key?: string;
  logId?: string;
  title: string;
}[] {
  return [...findingsByLogId.entries()].map(([logId, finding]) => ({
    albumImageUrl: finding.albumImageUrl,
    artists: finding.artists ?? [],
    bpm: finding.bpm,
    key: finding.key,
    logId,
    title: finding.title ?? "",
  }));
}

function summarize(value: unknown): string {
  const json = JSON.stringify(value ?? {});

  return json.length > 240 ? `${json.slice(0, 240)}…` : json;
}

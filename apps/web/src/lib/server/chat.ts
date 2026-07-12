// ChatDnB — Fluncle answers over his own archive (a PRIVATE, admin-gated SPIKE).
//
// ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────────────────
// Fluncle answers from the ARCHIVE or he does not answer. The model here holds his voice
// and nothing else: it knows no drum & bass, no track, no artist, no coordinate except what
// a tool hands back in THIS conversation. The tools are the only source of truth — the same
// discipline the search LLM tier already has (it emits FILTERS, never rows, so it *cannot*
// invent a track). Here the model can SPEAK, so the rail is the system prompt plus the tool
// boundary: a tool never returns an uncertified track, so the model can never see one to
// name. Grounding is the product; a hallucinated banger Fluncle never found is the one thing
// that would kill it.
//
// ── THE MCP IS THE HANDS — the path taken, and why ───────────────────────────────────
// "The MCP is the hands" (docs/planning ChatDnB): the model calls the same verbs the public
// MCP server (lib/server/mcp.ts) exposes to other people's agents. We wire them as AI SDK
// tools that call the EXACT server functions the MCP `execute` closures call — `listTracks`,
// `resolveLogPageTarget`, `getRandomTrack`, `getServiceStatuses`, plus `searchArchive` (the
// real archive resolver, the grounding search) — rather than opening an HTTP client back to
// our own /mcp endpoint. A Worker self-fetching its own route inside the same isolate is the
// awkward path the brief warns about (loopback + the MCP JSON-RPC round-trip for no gain);
// calling the in-process functions is the honest spike fallback the brief blesses, and it is
// LITERALLY the same hands, one function call closer. If ChatDnB ever needs to reach a
// DIFFERENT archive's MCP, swap these for `@ai-sdk`'s MCP client — the tool shapes match.
//
// Vendor plumbing follows the search-llm precedent: OpenRouter, the AI SDK v7 provider, a
// model from the same family the search tier trusts, and a hard "no key ⇒ 503" so an
// unprovisioned Worker fails honestly rather than pretending.

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { z } from "zod";
import { readOptionalEnv } from "./env";
import { resolveLogPageTarget } from "./log-resolver";
import { searchArchive } from "./search";
import { getServiceStatuses } from "./status";
import { getRandomTrack, listTracks, type TrackListItem, toPublicTrackListItem } from "./tracks";

/** The model family the search tier trusts (search-llm.ts / observation.ts default). */
const DEFAULT_CHAT_MODEL = "anthropic/claude-haiku-4.5";

/** How many tool→think steps one turn may take before we stop (a runaway guard). */
const MAX_STEPS = 8;

/** The recent-window and search caps handed to the tools (mirror the MCP's clamps). */
const MAX_RECENT = 48;
const MAX_SEARCH = 12;

// ── The grounding + voice prompt ─────────────────────────────────────────────────────
//
// It is a GROUNDING prompt first and a voice prompt second. Every "never invent" line is a
// rail; the voice lines make what he DOES say sound like him (VOICE.md / copywriting-fluncle
// references/voice.md). Kept as an exported const so the assembly is unit-testable without a
// model or a key.
export const FLUNCLE_CHAT_SYSTEM_PROMPT = `You are Fluncle — the uncle with the good records, doing this since '90, who also happens to travel time and space with a Discman and the cable still plugged in. You log what you find out there as findings and send them back to the crew across the Galaxy. You are talking to the crew now, in your own voice.

THE ONE RULE — YOU ANSWER FROM THE ARCHIVE OR YOU DO NOT ANSWER:
- You know nothing about drum & bass from memory. Every track, artist, label, BPM, key, galaxy, or Log ID coordinate you mention MUST come from a tool result in THIS conversation. No exceptions.
- Before you name a tune or an artist, call a tool. If you have not called a tool that returned it, you do not know it.
- If the tools return nothing for what you were asked, say so plainly, in voice — you have not been to that sector, or you have not found it yet. Never fill the gap with a track you did not find. A banger you never logged is the one thing you will not invent.
- Never invent a Log ID, a BPM, a key, a label, a date, or a link. If a tool did not give you the number, you do not have it.

THE ARCHIVE:
- Your findings are the tracks you have personally certified. A finding has a permanent Log ID coordinate like 004.7.2I; a mixtape carries the same shape with the letter F in the middle slot (019.F.1A). Use get_track to resolve a coordinate someone gives you.
- You only ever speak about your certified findings — the tools only return those. If it is not in a tool result, it is not something you talk about.
- search_archive is your dig: it reaches the whole archive, including "sounds like <a real track>" which anchors on a real finding and returns the sonically nearest ones. list_tracks pages your most recent findings; get_random_track pulls one; get_status checks whether your systems are up.

HOW YOU TALK:
- First person, warm, dry. You react like a body: knees, gun fingers, an "oof" when a tune lands. No exclamation marks, ever. No hype adjectives. State a thing once and leave it alone.
- Lead with what a tune did to you, then turn it to the crew — that is the selector's move. Name a finding as Artist — Title and drop its Log ID coordinate so they can find it.
- Keep it to a warm line or two. No bullet lists, no recap of what you just said, no corporate coda. Sentence case. You address one of the crew as junglist, raver, fam, or cosmonaut at the warm moments, never every line.
- Scene-native and never explained: tune, roller, rinse, 174, junglist. The cosmos rides along on a real feeling; it never replaces the verb.
- If someone asks for something the archive cannot answer — a track you have not found, a genre you do not log, a fact that is not in a finding — say so in voice and stop. That is not a failure; it is the honest answer.`;

// ── The hands: the archive verbs, wired as AI SDK tools ───────────────────────────────
//
// One compact shape per verb, only the fields Fluncle needs to SPEAK from — the coordinate,
// the names, and the facts a finding actually carries. Every tool reads through the same
// server functions the MCP server calls, so behaviour never drifts between the agent-facing
// MCP and this chat. THE GROUNDING BOUNDARY LIVES HERE: search_archive drops any uncertified
// row before the model sees it, so an uncertified catalogue track is not something the model
// can name (the catalogue rule, enforced at the wire, not just asked for in the prompt).

/** A finding as Fluncle needs to speak it: the coordinate, the names, the facts it carries. */
function compactFinding(item: TrackListItem) {
  const track = toPublicTrackListItem(item);

  return dropEmpty({
    album: track.album,
    artists: track.artists,
    bpm: track.bpm === undefined ? undefined : Math.round(track.bpm),
    coordinate: track.logId,
    found: track.addedAt,
    galaxy: track.galaxy?.name,
    key: track.key,
    label: track.label,
    note: track.note,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  });
}

/** Drop undefined/empty so a tool result carries only present, real facts (never a null). */
function dropEmpty<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === undefined || value === null) {
        return false;
      }

      return Array.isArray(value) ? value.length > 0 : true;
    }),
  ) as Partial<T>;
}

function clampInt(value: unknown, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return Math.min(value, max);
}

/**
 * Build the tool set. Pure and dependency-light so a test can assert the SHAPE (the names,
 * the schemas, the grounding filter) without a database — the `execute` closures are the
 * only part that touches Turso, and they are exercised by the route, not the unit test.
 */
export function buildChatTools(): ToolSet {
  return {
    get_random_track: tool({
      description: "Pull one random certified finding from the archive.",
      execute: async () => {
        const track = await getRandomTrack();

        return track ? { finding: compactFinding(track), ok: true } : { found: false, ok: true };
      },
      inputSchema: z.object({}),
    }),
    get_status: tool({
      description:
        "Check whether Fluncle's own systems are up (the website, API, media zone, terminal, and the rest). Read-only.",
      execute: async () => summarizeStatus(),
      inputSchema: z.object({}),
    }),
    get_track: tool({
      description:
        "Read one certified finding (or a mixtape) in full by its Log ID coordinate (e.g. 004.7.2I, or a mixtape's 019.F.1A) or a Spotify track id/URL. Returns nothing if the coordinate resolves to no finding — which means Fluncle has not found it.",
      execute: async ({ coordinate }) => {
        const target = await resolveLogPageTarget(coordinate.trim());

        if (!target) {
          return { found: false, ok: true };
        }

        return target.kind === "mixtape"
          ? { mixtape: compactMixtape(target.mixtape), ok: true }
          : { finding: compactFinding(target.track), ok: true };
      },
      inputSchema: z.object({
        coordinate: z
          .string()
          .describe("A Log ID coordinate (004.7.2I / 019.F.1A) or a Spotify track id or URL."),
      }),
    }),
    list_tracks: tool({
      description:
        "List Fluncle's most recent certified findings, newest first. Use to walk a recent night or see what he has been logging.",
      execute: async ({ limit }) => {
        // Findings only (no mixtapes) — a mixtape is reached by its F-coordinate through
        // get_track, and keeping the list findings-only means every row is a TrackListItem.
        const page = await listTracks({ limit: clampInt(limit, MAX_RECENT, 10) });

        return { findings: page.tracks.map(compactFinding), ok: true };
      },
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RECENT)
          .optional()
          .describe("How many (default 10)."),
      }),
    }),
    search_archive: tool({
      description:
        "Search Fluncle's archive of certified findings. Handles a name, a label, a key/BPM ask, or 'sounds like <a real track>' (anchors on a real finding and returns the sonically nearest). Returns only certified findings; an empty result means Fluncle has not found anything matching.",
      execute: async ({ query }) => {
        const result = await searchArchive({ limit: MAX_SEARCH, q: query.trim() });

        // THE GROUNDING BOUNDARY: an uncertified catalogue row has no coordinate and is
        // never something Fluncle speaks about — strip it before the model ever sees it.
        const findings = result.results
          .filter((hit) => hit.certified && hit.logId)
          .map((hit) => searchHitToFinding(hit));

        return dropEmpty({
          anchor: result.anchor?.certified ? searchHitToFinding(result.anchor) : undefined,
          findings,
          how: result.kind,
          ok: true as const,
        });
      },
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .describe("What to dig for — a name, a label, a key/BPM, or 'sounds like <track>'."),
      }),
    }),
  };
}

/** A search hit, reduced to the facts Fluncle speaks from (certified rows only reach here). */
function searchHitToFinding(hit: {
  album?: string;
  artists: string[];
  bpm?: number;
  galaxy?: string;
  key?: string;
  label?: string;
  logId?: string;
  title: string;
}) {
  return dropEmpty({
    album: hit.album,
    artists: hit.artists,
    bpm: hit.bpm === undefined ? undefined : Math.round(hit.bpm),
    coordinate: hit.logId,
    galaxy: hit.galaxy,
    key: hit.key,
    label: hit.label,
    title: hit.title,
  });
}

/** A mixtape reduced to what Fluncle speaks from — the checkpoint, not the full tracklist. */
function compactMixtape(mixtape: {
  durationMs?: number;
  logId?: string;
  memberCount?: number;
  note?: string | null;
  title: string;
}) {
  return dropEmpty({
    bangerCount: mixtape.memberCount,
    coordinate: mixtape.logId,
    note: mixtape.note ?? undefined,
    runtimeMs: mixtape.durationMs,
    title: mixtape.title,
  });
}

/** A one-line, model-facing status summary (reads the same store /status reads). */
async function summarizeStatus(): Promise<{ headline: string; ok: boolean }> {
  const rows = await getServiceStatuses();

  if (rows.length === 0) {
    return { headline: "No system has reported in yet.", ok: false };
  }

  const down = rows.filter((row) => row.status === "down").map((row) => row.service);
  const degraded = rows.filter((row) => row.status === "degraded").map((row) => row.service);

  if (down.length === 0 && degraded.length === 0) {
    return { headline: `All ${rows.length} systems are up.`, ok: true };
  }

  const parts = [
    down.length > 0 ? `${down.join(", ")} down` : "",
    degraded.length > 0 ? `${degraded.join(", ")} degraded` : "",
  ].filter(Boolean);

  return { headline: `Not all systems up: ${parts.join("; ")}.`, ok: false };
}

// ── The transcript stream ─────────────────────────────────────────────────────────────
//
// A deliberately small NDJSON protocol (one JSON object per line) so the bare /admin/chat
// workbench can render the GROUNDING WORK visibly — every tool call and its result land in
// the transcript, not just the final text. Fully under our control (no UI-message-stream
// framing to decode), which is the point for a workbench.

export type TranscriptEvent =
  | { text: string; type: "text" }
  | { input: unknown; name: string; type: "tool-call" }
  | { name: string; output: unknown; type: "tool-result" }
  | { error: string; name?: string; type: "tool-error" }
  | { error: string; type: "error" }
  | { type: "done" };

/**
 * Map one AI SDK stream part to a transcript event, or `null` to drop it (the low-level
 * start/step/input-delta chatter the workbench does not show). Pure — unit-tested directly.
 */
export function toTranscriptEvent(part: TextStreamPart<ToolSet>): TranscriptEvent | null {
  switch (part.type) {
    case "text-delta":
      return part.text ? { text: part.text, type: "text" } : null;
    case "tool-call":
      return { input: part.input, name: part.toolName, type: "tool-call" };
    case "tool-result":
      return { name: part.toolName, output: part.output, type: "tool-result" };
    case "tool-error":
      return { error: errorText(part.error), name: part.toolName, type: "tool-error" };
    case "error":
      return { error: errorText(part.error), type: "error" };
    case "finish":
      return { type: "done" };
    default:
      return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One NDJSON line for the wire. */
function encodeEvent(event: TranscriptEvent): string {
  return `${JSON.stringify(event)}\n`;
}

// ── Incoming messages ─────────────────────────────────────────────────────────────────

const ChatMessageSchema = z.object({
  content: z.string(),
  role: z.enum(["user", "assistant"]),
});

const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Parse the request body into the turn history, or `null` if it is malformed. A model turn is
 * untrusted input like any other; the caller answers a `null` with a 400.
 */
export function parseChatRequest(body: unknown): ChatMessage[] | null {
  const parsed = ChatRequestSchema.safeParse(body);

  return parsed.success ? parsed.data.messages : null;
}

/** The turn history as AI SDK model messages, with the grounding system prompt on the front. */
function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return [
    { content: FLUNCLE_CHAT_SYSTEM_PROMPT, role: "system" },
    ...messages.map((message) => ({ content: message.content, role: message.role })),
  ];
}

/** The chat model id — `OPENROUTER_CHAT_MODEL`, or the family the search tier trusts. */
export async function resolveChatModel(): Promise<string> {
  return (await readOptionalEnv("OPENROUTER_CHAT_MODEL")) ?? DEFAULT_CHAT_MODEL;
}

/**
 * Run one ChatDnB turn and stream the transcript as NDJSON.
 *
 * Returns `null` when there is no `OPENROUTER_API_KEY` — the caller answers 503, the honest
 * "the chat is unprovisioned" (this is a spike; there is no cheaper degraded chat to fall
 * back to, unlike search). The model, the grounding prompt, and the archive tools are wired
 * here; `signal` lets a client disconnect abort the model mid-turn.
 */
export async function streamChat(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array> | null> {
  const apiKey = await readOptionalEnv("OPENROUTER_API_KEY");

  if (!apiKey) {
    return null;
  }

  const openrouter = createOpenRouter({ apiKey });
  const model = await resolveChatModel();

  const result = streamText({
    abortSignal: signal,
    messages: toModelMessages(messages),
    model: openrouter(model),
    stopWhen: stepCountIs(MAX_STEPS),
    // Structure over flourish: he is grounding, not riffing. Low, not zero — the voice needs
    // a little air.
    temperature: 0.4,
    tools: buildChatTools(),
  });

  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const part of result.fullStream) {
          const event = toTranscriptEvent(part);

          if (event) {
            controller.enqueue(encoder.encode(encodeEvent(event)));
          }
        }
      } catch (error) {
        controller.enqueue(encoder.encode(encodeEvent({ error: errorText(error), type: "error" })));
      } finally {
        controller.close();
      }
    },
  });
}

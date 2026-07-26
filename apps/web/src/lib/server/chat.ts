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
  type InferUITools,
  type UIDataTypes,
  type UIMessage,
  convertToModelMessages,
  stepCountIs,
  streamText,
} from "ai";
import { z } from "zod";
import { readOptionalEnv } from "./env";
import { sharedChatTools } from "./tools/registry";

/** The model family the search tier trusts (search-llm.ts / observation.ts default). */
const DEFAULT_CHAT_MODEL = "anthropic/claude-haiku-4.5";

/** How many tool→think steps one turn may take before we stop (a runaway guard). */
const MAX_STEPS = 8;

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
- If the tools return nothing for what you were asked, say so plain, in voice — nothing came back from that sector, you haven't been out that far yet, or you haven't found it yet. Never fill the gap with a track you did not find. A banger you never logged is the one thing you will not invent.
- Never invent a Log ID, a BPM, a key, a label, a date, or a link. If a tool did not give you the number, you do not have it.
- When you chain a set, you state the REASON a track mixes in words — same key, next key over, tempo locked — never a compatibility number or a percentage. Reasons are words, not scores.

THE ARCHIVE:
- Your findings are the tracks you have personally certified. A finding has a permanent Log ID coordinate like 004.7.2I; a mixtape carries the same shape with the letter F in the middle slot (019.F.1A). Use get_track to resolve a coordinate someone gives you.
- Two kinds of thing come back from your tools. A finding is a track you certified: it carries a Log ID coordinate, and you speak about it in full — what it did to you, where it sits, all of it. A catalogue row is a record you know is out there but have never certified: it carries a name and its artists and nothing else. You may name it and list it when someone asks what is out there — that is all. You never react to it, never say what it does to you, never give it a coordinate, never start a set from it, and never say you found it or logged it. You never call it a catalogue row or any name for the tier out loud; the crew only ever hears its title and its artists. No coordinate in the result means it is not a finding. Never invent a catalogue row either — if a dig or a browse comes back empty, say so plain and stop.
- search_archive is your dig: it reaches the whole archive and comes back in both registers — the findings you certified, which you speak about in full, and catalogue rows you have not, which you only name and list. It handles "sounds like <a real track>", anchoring on a real finding and returning the sonically nearest. list_findings pages your most recent findings; list_tracks walks the whole archive by release date, the newest gear first, and can narrow to just the ones you certified or just the ones you have not; get_random_track pulls one; get_status checks whether your systems are up.
- list_fresh is what just came out: tracks RELEASED in the trailing month, freshest release first. These landed recently out in the wider world, so you say a tune just dropped or came out this month, never that you just found it. The ones you certified you speak about as just dropped; the ones you have not certified you only name and list, never as found. Each row carries the day it came out, so you can say when a tune dropped. That day is the release, never the day you found it.
- get_artist and get_label resolve one artist or label by name and hand back that entity's findings. Reach for them when someone asks about a specific artist or label. Naming an artist is always fine: even when you have certified nothing from them, get_artist still comes back with their name and the records of theirs you know are out there, and you name the artist and list those, never as found. The same holds for a label: even when you have certified nothing on it, get_label still comes back with its name and the records on it you know are out there, and you name the label and list those, never as found.
- list_similar_artists takes an artist you have logged and hands back the ones whose sound sits nearest across your findings — reach for it when someone wants artists like the one they named. Naming an artist is always fine, whether or not you have a finding from them.
- build_set starts from one of your findings — a Log ID coordinate or a track name you have logged — and chains an ordered set of what mixes in cleanly after it, each step carrying the reason it mixes. You start from a finding; the set can run on through tracks you have not certified, and those you leave unnamed. It returns nothing when you have not logged a starting point.

TAKING SOMETHING IN:
- submit_track takes a Spotify link a raver wants you to hear and drops it in your queue to listen to later. It is a recommendation, not a publish — you have not found it and you do not speak about it as a finding; you just tell them you will give it a listen.
- subscribe_newsletter boards an email on the Friday newsletter. You can do either right in the conversation when someone asks.

HOW YOU TALK:
- First person, warm, dry. With a FINDING you react like a body: knees, gun fingers, an "oof" when a tune lands. No exclamation marks, ever. No hype adjectives. State a thing once and leave it alone. That body is for findings only — a catalogue row gets none of it; you name it and move on.
- With a finding, lead with what it did to you, then turn it to the crew — that is the selector's move. Name it as Artist — Title and drop its Log ID coordinate so they can find it.
- Keep it to a warm line or two. No bullet lists, no recap of what you just said, no corporate coda. Sentence case. You address one of the crew as junglist, raver, fam, or cosmonaut at the warm moments, never every line.
- Scene-native and never explained: tune, roller, rinse, 174, junglist. The cosmos rides along on a real feeling; it never replaces the verb.
- If someone asks for something the archive cannot answer — a track you have not found, a genre you do not log, a fact that is not in a finding — say so in voice and stop. That is not a failure; it is the honest answer.`;

// ── The hands: the archive verbs, wired as AI SDK tools ───────────────────────────────
//
// Every tool ChatDnB exposes now comes from the shared registry (./tools/registry): the archive
// reads, the entity/dossier reads, the set builder, the "artists like this" read, and the two
// writes. Their name/description/schema/grounding are single-sourced there, so they never drift
// from the MCP, and the same in-process server functions back both surfaces.

/**
 * Build the tool set. `request` is threaded onto every tool's ctx so the WRITE tools (submit_track,
 * subscribe_newsletter) have the submitter hash / rate-limit context; the reads ignore it. Pure and
 * dependency-light so a test can assert the SHAPE (names + schemas) without a database — the
 * `execute` closures are the only part that touches Turso, exercised by the route, not the unit test.
 */
export function buildChatTools(request?: Request) {
  return sharedChatTools(request);
}

// ── The wire type ──────────────────────────────────────────────────────────────────────
//
// The chat rides the AI SDK UIMessage stream protocol end to end: `useChat` on the client
// posts `UIMessage[]` and `toUIMessageStreamResponse` streams UIMessage chunks back, so the
// GROUNDING WORK (every tool call and its result) arrives as typed tool parts the workbench
// renders inline — no bespoke framing to maintain.

/** The chat's message type: no metadata, no data parts, the archive verbs as typed tools. */
export type FluncleUIMessage = UIMessage<
  never,
  UIDataTypes,
  InferUITools<ReturnType<typeof buildChatTools>>
>;

// ── Incoming messages ─────────────────────────────────────────────────────────────────

// A structural guard, not a full UIMessage validation: enough to confirm the body is a
// non-empty turn history of user/assistant messages that each carry a `parts` array. The
// grounding system prompt never rides in `messages` (it goes through `instructions`), so a
// `system` role from the wire is rejected outright.
// ── The size caps ─────────────────────────────────────────────────────────────────────
//
// THE RATE LIMITER CAPS FREQUENCY, NOT SIZE. This is a POST body — not a GET query bounded
// by Cloudflare's ~16KB URL limit — so without a size bound one request can carry megabytes
// of turn history straight into `convertToModelMessages` and out to a PAID model, in a 128MB
// isolate. The tier (private session + verified email + same-origin/CSRF + 30/hr) still lets
// one account spend 30 × max-context per hour, and a Spotify login is open to anyone. So the
// ceilings below are the per-request budget.
//
// OVERFLOW IS A REJECT, NEVER A TRUNCATION: silently dropping the oldest messages or the tail
// of a text part would hand the model a conversation the crew did not have — a grounding
// failure wearing a working answer's face. A 400 tells the client the truth.
//
// SIZING (generous by design — no real conversation reaches these):
//   - messages: a `useChat` history grows by 2 per exchange, so 100 is ~50 exchanges in one
//     unbroken session. Well past any workbench sitting; nowhere near a multi-MB body.
//   - parts per message: a model turn is text plus its tool calls, and `MAX_STEPS` caps a turn
//     at 8 tool→think steps ⇒ ~17 parts worst case. 20 leaves headroom without inviting a
//     thousand-part message.
//   - characters per text part: 16,000 chars ≈ 4k tokens for ONE typed message. The longest
//     thing a raver plausibly pastes is a tracklist; this is far above it.
//   - characters across the WHOLE request: the three caps above multiply (100 × 20 × 16,000 is
//     still 32MB), so the total is what actually bounds the bill. It counts EVERY string in
//     EVERY part, not only `type: "text"` — the client posts the assistant's tool parts back
//     with the history, so a caller can forge a huge `tool-*` output just as easily as a huge
//     message. 200,000 chars ≈ 50k tokens: more context than the longest real session, and a
//     hard ceiling on what one request can cost no matter how it is shaped.
export const MAX_CHAT_MESSAGES = 100;
export const MAX_PARTS_PER_MESSAGE = 20;
export const MAX_TEXT_PART_CHARS = 16_000;
export const MAX_CHAT_TOTAL_CHARS = 200_000;

/**
 * One message part. `looseObject` keeps every field the AI SDK's own part types carry (the
 * schema is a structural guard, not a re-implementation of `UIMessage`), so the size bound has
 * to be a refinement rather than a field: a `type: "text"` part's `text` may not exceed
 * {@link MAX_TEXT_PART_CHARS}. A part of another type (a `tool-*` result the client posted back)
 * is not bounded HERE — it is bounded by the aggregate {@link MAX_CHAT_TOTAL_CHARS}, which counts
 * every string in every part, so no part type escapes a ceiling.
 */
const ChatPartSchema = z.looseObject({ type: z.string() }).refine(
  (part) => {
    if (part.type !== "text") {
      return true;
    }

    const text = (part as { text?: unknown }).text;

    return typeof text !== "string" || text.length <= MAX_TEXT_PART_CHARS;
  },
  { message: `A text part may not exceed ${MAX_TEXT_PART_CHARS} characters` },
);

const ChatRequestSchema = z
  .object({
    messages: z
      .array(
        z.looseObject({
          parts: z.array(ChatPartSchema).max(MAX_PARTS_PER_MESSAGE),
          role: z.enum(["assistant", "user"]),
        }),
      )
      .min(1)
      .max(MAX_CHAT_MESSAGES),
  })
  // The aggregate ceiling, applied after the per-item ones so a body that satisfies all three
  // still cannot multiply its way to a multi-MB turn.
  .refine((body) => withinTotalChars(body.messages), {
    message: `The conversation may not exceed ${MAX_CHAT_TOTAL_CHARS} characters`,
  });

/**
 * How deep into a part's value tree the character walk descends before refusing the body.
 *
 * SIZING: the deepest real part is a tool result — `part.output.hits[i].artists[j]` is 5 levels
 * from the part — so 12 is roughly double the deepest shape the archive tools return. Kept
 * generous on purpose: this bound rejects, so a too-tight value would 400 a real conversation.
 */
const PART_WALK_MAX_DEPTH = 12;

/**
 * Is the turn history within {@link MAX_CHAT_TOTAL_CHARS} of total string content?
 *
 * Walks every string inside every part rather than only `type: "text"` — the client posts the
 * assistant's `tool-*` parts back with the history, so any field is caller-controlled. It
 * SHORT-CIRCUITS the moment the running total passes the cap and never serializes anything, so
 * a hostile 32MB body is rejected without a second copy of it in the isolate.
 *
 * A value tree deeper than {@link PART_WALK_MAX_DEPTH} is REJECTED rather than left uncounted:
 * bailing out of the walk would be a hole (nest the payload one level deeper than the walk goes
 * and it stops counting), and no real part nests that far. The bound also keeps the recursion
 * shallow whatever the body does.
 */
function withinTotalChars(
  messages: ReadonlyArray<{ parts: ReadonlyArray<Record<string, unknown>> }>,
): boolean {
  let total = 0;
  let tooDeep = false;

  const walk = (value: unknown, depth: number): void => {
    if (tooDeep || total > MAX_CHAT_TOTAL_CHARS) {
      return;
    }

    if (typeof value === "string") {
      total += value.length;

      return;
    }

    if (typeof value !== "object" || value === null) {
      return;
    }

    if (depth >= PART_WALK_MAX_DEPTH) {
      tooDeep = true;

      return;
    }

    for (const entry of Array.isArray(value) ? value : Object.values(value)) {
      walk(entry, depth + 1);
    }
  };

  for (const message of messages) {
    for (const part of message.parts) {
      // `type` is the part's discriminator, not payload — skipping it keeps the cap a statement
      // about content (and keeps the ceiling exact rather than "minus a few chars per part").
      for (const [key, value] of Object.entries(part)) {
        if (key !== "type") {
          walk(value, 1);
        }
      }

      if (tooDeep || total > MAX_CHAT_TOTAL_CHARS) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Parse the request body into the turn history, or `null` if it is malformed. A model turn is
 * untrusted input like any other; the caller answers a `null` with a 400.
 */
export function parseChatRequest(body: unknown): FluncleUIMessage[] | null {
  const parsed = ChatRequestSchema.safeParse(body);

  return parsed.success ? (parsed.data.messages as unknown as FluncleUIMessage[]) : null;
}

/** The chat model id — `OPENROUTER_CHAT_MODEL`, or the family the search tier trusts. */
export async function resolveChatModel(): Promise<string> {
  return (await readOptionalEnv("OPENROUTER_CHAT_MODEL")) ?? DEFAULT_CHAT_MODEL;
}

/**
 * Run one ChatDnB turn and stream it back as an AI SDK UIMessage stream `Response`.
 *
 * Returns `null` when there is no `OPENROUTER_API_KEY` — the caller answers 503, the honest
 * "the chat is unprovisioned" (this is a spike; there is no cheaper degraded chat to fall
 * back to, unlike search). The model, the grounding prompt, and the archive tools are wired
 * here; `signal` lets a client disconnect abort the model mid-turn. `request` is the inbound
 * gated /api/chat request, threaded into the WRITE tools' ctx (submit_track / subscribe_newsletter
 * need the submitter hash + rate-limit context; the reads ignore it). The grounding system prompt
 * does NOT ride in `messages` — AI SDK 7 rejects `role: "system"` there outright — it goes through
 * `streamText`'s top-level `instructions` option instead.
 */
export async function streamChat(
  messages: FluncleUIMessage[],
  signal?: AbortSignal,
  request?: Request,
): Promise<Response | null> {
  const apiKey = await readOptionalEnv("OPENROUTER_API_KEY");

  if (!apiKey) {
    return null;
  }

  const openrouter = createOpenRouter({ apiKey });
  const model = await resolveChatModel();

  const result = streamText({
    abortSignal: signal,
    instructions: FLUNCLE_CHAT_SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    model: openrouter(model),
    stopWhen: stepCountIs(MAX_STEPS),
    // Structure over flourish: he is grounding, not riffing. Low, not zero — the voice needs
    // a little air.
    temperature: 0.4,
    tools: buildChatTools(request),
  });

  return result.toUIMessageStreamResponse();
}

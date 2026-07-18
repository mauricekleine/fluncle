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

import { type MixCandidate } from "@fluncle/contracts";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  type InferUITools,
  type ToolSet,
  type UIDataTypes,
  type UIMessage,
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { z } from "zod";
import { isLogId, isMixtapeLogId } from "../log-id";
import { MAX_SET_LENGTH, mixReasonLabel, serializeSet, setToken } from "../mix-set";
import {
  countArtistFindings,
  getArtistBySlug,
  getPublicArtistSocials,
  toArtistSlug,
} from "./artists";
import { readOptionalEnv } from "./env";
import { getConfirmedAliasNames, getLabelBySlug, labelSlug } from "./labels";
import { resolveLogPageTarget } from "./log-resolver";
import { searchArchive } from "./search";
import { compactFinding, dropEmpty, sharedChatTools } from "./tools/registry";
import {
  getFindingsByArtist,
  getFindingsByLabel,
  getMixableTracks,
  getMixChainDepth,
  getTracksByLogIds,
  type TrackListItem,
} from "./tracks";

/** The model family the search tier trusts (search-llm.ts / observation.ts default). */
const DEFAULT_CHAT_MODEL = "anthropic/claude-haiku-4.5";

/** How many tool→think steps one turn may take before we stop (a runaway guard). */
const MAX_STEPS = 8;

/** The search cap handed to the archive-search tool (mirrors the MCP's clamp). */
const MAX_SEARCH = 12;

/**
 * How many mixable steps `build_set` chains off the seed — one full rail's worth of what mixes
 * in next, before the certified-only filter thins it. The seed leads, so the set the card shows
 * (and the `?set=` link it hands to `/mix`) is at most this many rows plus the seed.
 */
const MIX_CHAIN_LIMIT = 7;

/**
 * How many of an entity's findings ride on a `get_artist`/`get_label` card — the recent/
 * representative ones. The card links to the full `/artist` or `/label` page for the rest, so a
 * dossier reads as a conversation, not a discography dump.
 */
const MAX_ENTITY_FINDINGS = 6;

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
- When you chain a set, you state the REASON a track mixes in words — same key, next key over, tempo locked — never a compatibility number or a percentage. Reasons are words, not scores.

THE ARCHIVE:
- Your findings are the tracks you have personally certified. A finding has a permanent Log ID coordinate like 004.7.2I; a mixtape carries the same shape with the letter F in the middle slot (019.F.1A). Use get_track to resolve a coordinate someone gives you.
- You only ever speak about your certified findings — the tools only return those. If it is not in a tool result, it is not something you talk about.
- search_archive is your dig: it reaches the whole archive, including "sounds like <a real track>" which anchors on a real finding and returns the sonically nearest ones. list_tracks pages your most recent findings; get_random_track pulls one; get_status checks whether your systems are up.
- list_fresh is what just came out: the findings whose track was RELEASED in the trailing month, freshest release first. These landed recently out in the wider world, so you say a tune just dropped or came out this month, never that you just found it. When a record came out is not when you found it.
- get_artist and get_label resolve one artist or label you have logged, by name, and hand back that entity's findings — reach for them when someone asks about a specific artist or label you have found.
- build_set starts from one of your findings — a Log ID coordinate or a track name you have logged — and chains an ordered set of what mixes in cleanly after it, each step carrying the reason it mixes. It only ever chains certified findings, and returns nothing when you have not logged a starting point.

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

/**
 * Compact an entity's findings for a card, CERTIFIED-ONLY. `getFindingsByArtist`/`getFindingsByLabel`
 * already inner-join `findings … log_id is not null`, but the coordinate filter is the same wire-level
 * grounding boundary search_archive applies — a row without a coordinate is not something Fluncle
 * speaks about, so it never reaches the model even if a resolver's shape ever changed. Newest-first is
 * preserved from the resolver; the caller slices to {@link MAX_ENTITY_FINDINGS}.
 */
function compactCertifiedFindings(items: TrackListItem[]) {
  return items.map(compactFinding).filter((finding) => finding.coordinate);
}

/**
 * Build the tool set. Pure and dependency-light so a test can assert the SHAPE (the names,
 * the schemas, the grounding filter) without a database — the `execute` closures are the
 * only part that touches Turso, and they are exercised by the route, not the unit test.
 */
export function buildChatTools() {
  return {
    // The five overlapping read tools (get_track, get_random_track, get_status, list_fresh,
    // list_tracks) are projected from the shared registry (./tools/registry), so their
    // name/description/schema and grounding never drift from the MCP or WebMCP.
    ...sharedChatTools(),
    build_set: tool({
      description:
        "Chain a mixable set from one of Fluncle's findings. Give it a starting finding — a Log ID coordinate he has logged (e.g. 004.7.2I) or a track name — and it returns an ordered set of what mixes in cleanly after it, each step carrying the REASON it mixes (same key, next key over, tempo locked), never a number. It only ever chains certified findings; it returns nothing when he has not logged a starting point.",
      execute: async ({ seed }) => {
        const seedTrack = await resolveSeedTrack(seed.trim());

        // Grounding: no certified finding to start from is the honest "he has not logged it".
        if (!seedTrack) {
          return { found: false, ok: true };
        }

        const seedFinding = compactFinding(seedTrack);
        const candidates = await getMixableTracks(seedTrack.logId ?? seedTrack.trackId, {
          limit: MIX_CHAIN_LIMIT,
        });

        // THE GROUNDING BOUNDARY: only a certified, coordinate-bearing candidate can be named
        // or ride the `?set=` handoff. An uncertified/coordinateless catalogue row never reaches
        // the model or the mixer link (the Unlit Rule, enforced at the wire).
        const steps = candidates.flatMap((candidate) =>
          candidate.certified && candidate.logId ? [candidate] : [],
        );

        if (steps.length === 0) {
          // Seed alone. When the archive itself is too thin to chain a set from the middle of it,
          // say so in voice rather than handing back a lonely seed — the honest "not enough yet".
          const depth = await getMixChainDepth();

          return {
            ok: true,
            set: dropEmpty({ seed: seedFinding, steps: [], thin: depth.open ? undefined : true }),
          };
        }

        // Hydrate the certified steps to full findings (cover, chips, hasPreview) — the same batch
        // hydrate search uses — then carry each candidate's reason as a human STRING, never the
        // object and never a score.
        const hydrated = await getTracksByLogIds(
          steps.flatMap((step) => (step.logId ? [step.logId] : [])),
        );
        const chain = steps.map((candidate) => {
          const item = candidate.logId ? hydrated[candidate.logId] : undefined;
          const base = item ? compactFinding(item) : mixTrackToFinding(candidate);

          return { ...base, reason: mixReasonLabel(candidate.reason) };
        });

        // The seed leads, then the chain in order — the set as `/mix` reproduces it. Every token
        // is a certified Log ID (the boundary already dropped the rest), capped at the URL max.
        const tokens = [setToken(seedTrack), ...steps.map((step) => setToken(step))].slice(
          0,
          MAX_SET_LENGTH,
        );

        return {
          ok: true,
          set: dropEmpty({
            seed: seedFinding,
            setUrl: `/mix?set=${serializeSet(tokens)}`,
            steps: chain,
          }),
        };
      },
      inputSchema: z.object({
        seed: z
          .string()
          .min(1)
          .describe("A finding to start from — a Log ID coordinate (004.7.2I) or a track name."),
      }),
    }),
    get_artist: tool({
      description:
        "Look up one artist Fluncle has logged, BY NAME (e.g. Netsky). Returns only his certified findings from that artist, plus their public socials and the slug of their page. Returns nothing — he has not logged them — when there is no certified finding from that name.",
      execute: async ({ name }) => {
        const slug = toArtistSlug(name.trim());
        const artist = slug ? await getArtistBySlug(slug) : undefined;

        if (!artist) {
          return { found: false, ok: true };
        }

        const [findingCount, findingItems, socials] = await Promise.all([
          countArtistFindings(artist.id),
          getFindingsByArtist(artist.id, artist.name),
          getPublicArtistSocials(artist.id),
        ]);
        const certified = compactCertifiedFindings(findingItems);

        // Grounding: an artist Fluncle has never certified a finding from is not something he
        // speaks about — the honest "not found", exactly like an unresolved slug.
        if (findingCount === 0 && certified.length === 0) {
          return { found: false, ok: true };
        }

        const findings = certified.slice(0, MAX_ENTITY_FINDINGS);

        return {
          artist: dropEmpty({
            // No avatar rides on the artist record; the freshest certified finding's cover is
            // the representative image (ArtistAvatar/TrackArtwork degrade to a monogram tile).
            avatarUrl: findings[0]?.albumImageUrl,
            // The voiced entity bio — undefined until one is authored, so `dropEmpty` ships it
            // only when it is real (the card renders it as a quiet intro paragraph).
            bio: artist.bio,
            findingCount,
            findings,
            name: artist.name,
            slug: artist.slug,
            socials,
            spotifyUrl: artist.spotifyUrl,
          }),
          ok: true,
        };
      },
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe("The artist's name, as it reads on a finding (e.g. Netsky)."),
      }),
    }),
    get_label: tool({
      description:
        "Look up one label Fluncle has logged, BY NAME (e.g. Hospital Records). Returns only his certified findings on that label, plus any confirmed alternate spellings and the slug of its page. Returns nothing — he has found nothing on it — when there is no certified finding on that name.",
      execute: async ({ name }) => {
        const slug = labelSlug(name);
        const label = slug ? await getLabelBySlug(slug) : undefined;

        if (!label) {
          return { found: false, ok: true };
        }

        const certified = compactCertifiedFindings(await getFindingsByLabel(label.id));

        // Grounding: a label Fluncle has no certified finding on is not something he speaks about.
        if (certified.length === 0) {
          return { found: false, ok: true };
        }

        const aliases = await getConfirmedAliasNames(label.id);

        return {
          label: dropEmpty({
            aliases,
            // The voiced entity bio — undefined until one is authored, so `dropEmpty` ships it
            // only when it is real (the card renders it as a quiet intro paragraph).
            bio: label.bio,
            findingCount: certified.length,
            findings: certified.slice(0, MAX_ENTITY_FINDINGS),
            logoUrl: label.logoImageUrl,
            name: label.name,
            slug: label.slug,
          }),
          ok: true,
        };
      },
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe("The label's name, as it reads on a finding (e.g. Hospital Records)."),
      }),
    }),
    search_archive: tool({
      description:
        "Search Fluncle's archive of certified findings. Handles a name, a label, a key/BPM ask, or 'sounds like <a real track>' (anchors on a real finding and returns the sonically nearest). Returns only certified findings; an empty result means Fluncle has not found anything matching.",
      execute: async ({ query }) => {
        const result = await searchArchive({ limit: MAX_SEARCH, q: query.trim() });

        // THE GROUNDING BOUNDARY, FIRST: an uncertified catalogue row has no coordinate and is
        // never something Fluncle speaks about — strip it before anything else (before the
        // hydrator is ever asked about it, so no uncertified logId is even looked up).
        const certifiedHits = result.results.filter((hit) => hit.certified && hit.logId);

        // A search hit carries no artwork/duration/preview; batch-hydrate the certified ones so
        // each card can show its cover, chips, and a play control. A logId the hydrator misses
        // falls back to the bare hit shape (still certified, just without the display extras).
        const hydrated = await getTracksByLogIds(
          certifiedHits.flatMap((hit) => (hit.logId ? [hit.logId] : [])),
        );
        const findings = certifiedHits.map((hit) => {
          const item = hit.logId ? hydrated[hit.logId] : undefined;

          return item ? compactFinding(item) : searchHitToFinding(hit);
        });

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
  } satisfies ToolSet;
}

/**
 * Resolve `build_set`'s seed to a CERTIFIED finding Fluncle can chain from, or `undefined`.
 *
 * A coordinate (a finding's, or a mixtape's) resolves directly — but a mixtape is not a mixable
 * seed, so a mixtape target is rejected as not-found. Anything else is treated as a NAME: the top
 * certified search hit is the start (an uncertified hit is not something he opens a set from — the
 * grounding boundary), hydrated to the full finding the mixer engine keys off.
 */
async function resolveSeedTrack(seed: string): Promise<TrackListItem | undefined> {
  if (!seed) {
    return undefined;
  }

  if (isLogId(seed) || isMixtapeLogId(seed)) {
    const target = await resolveLogPageTarget(seed);

    return target?.kind === "track" ? target.track : undefined;
  }

  const result = await searchArchive({ limit: MAX_SEARCH, q: seed });
  const hit = result.results.find((row) => row.certified && row.logId);

  if (!hit?.logId) {
    return undefined;
  }

  return (await getTracksByLogIds([hit.logId]))[hit.logId];
}

/**
 * A mix candidate reduced to the finding fields the Chain Card needs, WITHOUT its `previewUrl`
 * (a mix candidate carries none anyway) — the fallback for a certified step the batch hydrator
 * missed, so it still shows a cover, chips, and its coordinate. The reason chip is added by the
 * caller as a human string; this never carries a score.
 */
function mixTrackToFinding(candidate: MixCandidate) {
  return dropEmpty({
    albumImageUrl: candidate.albumImageUrl,
    artists: candidate.artists,
    bpm: candidate.bpm === undefined ? undefined : Math.round(candidate.bpm),
    coordinate: candidate.logId,
    durationMs: candidate.durationMs,
    hasPreview: false,
    key: candidate.key,
    spotifyUrl: candidate.spotifyUrl,
    title: candidate.title,
  });
}

/** A search hit, reduced to the facts Fluncle speaks from (certified rows only reach here). */
function searchHitToFinding(hit: {
  album?: string;
  albumImageUrl?: string;
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
    albumImageUrl: hit.albumImageUrl,
    artists: hit.artists,
    bpm: hit.bpm === undefined ? undefined : Math.round(hit.bpm),
    coordinate: hit.logId,
    galaxy: hit.galaxy,
    key: hit.key,
    label: hit.label,
    title: hit.title,
  });
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
const ChatRequestSchema = z.object({
  messages: z
    .array(
      z.looseObject({
        parts: z.array(z.looseObject({ type: z.string() })),
        role: z.enum(["assistant", "user"]),
      }),
    )
    .min(1),
});

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
 * here; `signal` lets a client disconnect abort the model mid-turn. The grounding system
 * prompt does NOT ride in `messages` — AI SDK 7 rejects `role: "system"` there outright — it
 * goes through `streamText`'s top-level `instructions` option instead.
 */
export async function streamChat(
  messages: FluncleUIMessage[],
  signal?: AbortSignal,
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
    tools: buildChatTools(),
  });

  return result.toUIMessageStreamResponse();
}

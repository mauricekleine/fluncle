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
import { samplingFor } from "./model-sampling";
import { sharedChatTools } from "./tools/registry";

const DEFAULT_CHAT_MODEL = "anthropic/claude-haiku-4.5";

const MAX_STEPS = 8;

export const FLUNCLE_CHAT_SYSTEM_PROMPT = `You are Fluncle — the uncle with the good records, doing this since '90, who also happens to travel time and space with a Discman and the cable still plugged in. You log what you find out there as findings and send them back to the crew across the Galaxy. You are talking to the crew now, in your own voice.

THE ONE RULE — YOU ANSWER FROM THE ARCHIVE OR YOU DO NOT ANSWER:
- You know nothing about drum & bass from memory. Every track, artist, label, BPM, key, galaxy, or Log ID coordinate you mention MUST come from a tool result in THIS conversation. No exceptions.
- Before you name a tune or an artist, call a tool. If you have not called a tool that returned it, you do not know it.
- If the tools return nothing for what you were asked, say so plain, in voice — nothing came back from that sector, you haven't been out that far yet, or you haven't found it yet. Never fill the gap with a track you did not find. A banger you never logged is the one thing you will not invent.
- Never invent a Log ID, a BPM, a key, a label, a date, or a link. If a tool did not give you the number, you do not have it.
- When you chain a set, you state the REASON a track mixes in words — same key, next key over, tempo locked — never a compatibility number or a percentage. Reasons are words, not scores.

THE ARCHIVE:
- Your findings are the tracks you have personally certified. A finding has a permanent Log ID coordinate like 004.7.2I; a mixtape carries the same shape with the letter F in the middle slot (019.F.1A). Resolve a coordinate someone gives you with a tool before you speak about it.
- Two kinds of thing come back from your tools. A finding is a track you certified: it carries a Log ID coordinate, and you speak about it in full — what it did to you, where it sits, all of it. A catalogue row is a record you know is out there but have never certified: it carries a name and its artists and nothing else. You may name it and list it when someone asks what is out there — that is all. You never react to it, never say what it does to you, never give it a coordinate, never start a set from it, and never say you found it or logged it. You never call it a catalogue row or any name for the tier out loud; the crew only ever hears its title and its artists. No coordinate in the result means it is not a finding. Never invent a catalogue row either — if a dig or a browse comes back empty, say so plain and stop.
- A release date is when a tune came out in the wider world, never when you found it. A tool that lists by release date is telling you what just dropped; say it dropped or came out this month, never that you just found it. The ones you certified you speak about as just dropped; the ones you have not certified you only name and list.
- Naming an artist, a label, or an album is always fine, whether or not you have certified anything from them. What comes back that you have not certified you name and list, never as found.
- When you chain a set, you start from one of your own findings, a Log ID coordinate or a track name you have logged. The chain may run on through tracks you have not certified, and those you leave unnamed.

TAKING SOMETHING IN:
- A Spotify link a raver wants you to hear goes in your queue to listen to later. It is a recommendation, not a publish: you have not found it and you do not speak about it as a finding; you just tell them you will give it a listen.
- Boarding an email on the Friday newsletter you can do right in the conversation when someone asks.

HOW YOU TALK:
- First person, warm, dry. With a FINDING you react like a body: knees, gun fingers, an "oof" when a tune lands. No exclamation marks, ever. No hype adjectives. State a thing once and leave it alone. That body is for findings only — a catalogue row gets none of it; you name it and move on.
- With a finding, lead with what it did to you, then turn it to the crew — that is the selector's move. Name it as Artist — Title and drop its Log ID coordinate so they can find it.
- Keep it to a warm line or two. No bullet lists, no recap of what you just said, no corporate coda. Sentence case. You address one of the crew as junglist, raver, fam, or cosmonaut at the warm moments, never every line.
- Scene-native and never explained: tune, roller, rinse, 174, junglist. The cosmos rides along on a real feeling; it never replaces the verb.
- If someone asks for something the archive cannot answer — a track you have not found, a genre you do not log, a fact that is not in a finding — say so in voice and stop. That is not a failure; it is the honest answer.`;

export function buildChatTools(request?: Request) {
  return sharedChatTools(request);
}

export type FluncleUIMessage = UIMessage<
  never,
  UIDataTypes,
  InferUITools<ReturnType<typeof buildChatTools>>
>;

export const MAX_CHAT_MESSAGES = 100;
export const MAX_PARTS_PER_MESSAGE = 20;
export const MAX_TEXT_PART_CHARS = 16_000;
export const MAX_CHAT_TOTAL_CHARS = 200_000;

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

  .refine((body) => withinTotalChars(body.messages), {
    message: `The conversation may not exceed ${MAX_CHAT_TOTAL_CHARS} characters`,
  });

const PART_WALK_MAX_DEPTH = 12;

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

export function parseChatRequest(body: unknown): FluncleUIMessage[] | null {
  const parsed = ChatRequestSchema.safeParse(body);

  return parsed.success ? (parsed.data.messages as unknown as FluncleUIMessage[]) : null;
}

export async function resolveChatModel(): Promise<string> {
  return (await readOptionalEnv("OPENROUTER_CHAT_MODEL")) ?? DEFAULT_CHAT_MODEL;
}

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

    ...samplingFor(model, 0.4),
    tools: buildChatTools(request),
  });

  return result.toUIMessageStreamResponse();
}

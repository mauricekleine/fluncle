import { isToolUIPart } from "ai";
import { type FluncleUIMessage } from "@/lib/server/chat";
import { type ChatCatalogueTrack } from "./catalogue-card";
import { type ChatFinding } from "./finding-card";

// The pure half of ChatDnB's tool-output rendering: reading a tool result into what the transcript
// shows, with no JSX. Split out (like chat-coordinate's `splitOnCoordinates`) so the register-split
// decision and the transcript's finding walk are unit-testable without importing the whole
// conversation component graph (useChat, the preview singleton, the cards). The card types are
// imported TYPE-ONLY, so this module never drags their JSX into a Node test.

/**
 * The decision behind a two-bucket list output (search_archive / list_fresh): which buckets render,
 * and whether the catalogue block is headed. THE RENDER FIX: both buckets surface — never either/or
 * (a naive branch on catalogue-first would hide the findings). The catalogue block is headed
 * "Tracks" (the true superset, the search-command / mix-builder precedent) ONLY when findings render
 * above it; a catalogue-only answer stays bare, because a heading over the only content would just
 * name the tier (the Unlit Rule). The gate is `findings.length > 0`, exactly like search-command's
 * `headUnlit`; the sonic anchor is a "near" reference, not a findings heading, so it never lights
 * the heading on its own.
 */
export type ListOutputPlan = {
  anchor?: ChatFinding;
  catalogue: ChatCatalogueTrack[];
  catalogueHeading?: string;
  findings: ChatFinding[];
};

/** Read a `{ findings, catalogue }` list output into a render plan, or `undefined` when it is neither. */
export function planListOutput(output: unknown): ListOutputPlan | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }

  const findings =
    "findings" in output && Array.isArray(output.findings)
      ? (output.findings as ChatFinding[])
      : [];
  const catalogue =
    "catalogue" in output && Array.isArray(output.catalogue)
      ? (output.catalogue as ChatCatalogueTrack[])
      : [];

  if (findings.length === 0 && catalogue.length === 0) {
    return undefined;
  }

  const anchor = "anchor" in output && output.anchor ? (output.anchor as ChatFinding) : undefined;

  return {
    anchor,
    catalogue,
    catalogueHeading: findings.length > 0 ? "Tracks" : undefined,
    findings,
  };
}

/**
 * Every finding visible on the transcript, deduped by coordinate — the FULL tool-output shape, so
 * both consumers read one walk: the now-playing bar derives its lean rows from it, and the prose
 * coordinate links (chat-coordinate.tsx) hand it to their hover cards, which is why a coordinate
 * Fluncle just dug needs no fetch at all.
 *
 * It keys off `finding` / `anchor` / `findings` / `set` / entity ONLY — never a `catalogue` bucket —
 * so an unlit catalogue row (which carries no coordinate anyway) can never be swept in as a
 * previewable finding. That distinct-key guarantee is what keeps the register split honest here.
 */
export function collectChatFindings(messages: FluncleUIMessage[]): Map<string, ChatFinding> {
  const byLogId = new Map<string, ChatFinding>();

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
      // findings, so the now-playing bar reaches them the same as a top-level result set. A
      // catalogue step carries no coordinate, so the coordinate guard below drops it.
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
          byLogId.set(finding.coordinate, finding);
        }
      }
    }
  }

  return byLogId;
}

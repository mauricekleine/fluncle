import { CheckIcon, CircleNotchIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type NoteRejection } from "@fluncle/contracts";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Separator } from "@fluncle/ui/components/separator";

// THE HELD NOTE — the echo gate's rejection, made readable.
//
// The gate refuses to STORE an auto-note that lifts a phrase from a sonic neighbour or
// reuses its words wholesale. It still refuses; nothing here weakens it. What it no longer
// does is refuse in the DARK. The line the model wrote is kept, and this panel is where the
// operator reads it — next to the neighbour it echoed, with the lifted words marked in
// BOTH, and the score sitting beside the threshold it was judged against.
//
// The side-by-side is the whole design. "This note scored 0.34" is a number; "this note
// scored 0.34, the gate sits at 0.30, and here is the sentence it echoed" is evidence. Only
// the second lets him tell a good rejection from a badly-tuned one — and that judgment is
// the thing #502 took away from him by deleting the note.
//
// Three rulings, one of them not binary: KEEP it (writes it, verbatim, through the same
// atomic fill-empty-only predicate the agent takes), EDIT it (drops it into the textarea
// above as a draft — the common case, since the model is usually 90% right and echoed one
// clause), or BIN it (the gate was right; the finding stays note-less and the sweep is free
// to try again).

const REJECTIONS_KEY = (trackId: string) => ["admin", "note-rejections", trackId] as const;

type HeldNoteResponse = {
  gate: { maxOverlap: number; minPhraseWords: number };
  rejections: NoteRejection[];
};

async function fetchHeldNote(trackId: string): Promise<HeldNoteResponse> {
  const response = await fetch(
    `/api/v1/admin/note-rejections?trackId=${encodeURIComponent(trackId)}`,
  );

  if (!response.ok) {
    throw new Error("Could not read the held note.");
  }

  return (await response.json()) as HeldNoteResponse;
}

async function resolveHeldNote(id: string, resolution: "accepted" | "discarded"): Promise<void> {
  const response = await fetch(`/api/v1/admin/note-rejections/${encodeURIComponent(id)}/resolve`, {
    body: JSON.stringify({ resolution }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Could not rule on the held note.",
    );
  }
}

/** A word as the echo scorer sees it (lowercase, punctuation stripped) — the match key. */
function echoKey(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Mark the lifted run inside a note, working on the ORIGINAL text so the operator reads the
 * note as written (punctuation, capitals and all) with only the echoed words marked.
 *
 * The stored `phrase` is normalized (the scorer lowercases and strips punctuation), so a
 * naive substring search would miss "shoulders dropped, before" against "shoulders dropped
 * before". Matching runs of NORMALIZED tokens against the original token stream is what
 * makes the highlight land on the real words.
 */
function markPhrase(text: string, phrase: string) {
  const wanted = phrase.split(" ").filter(Boolean).map(echoKey);

  if (wanted.length === 0) {
    return text;
  }

  // Split into words and the whitespace between them, keeping both so the original spacing
  // survives reassembly.
  const parts = text.split(/(\s+)/);
  const wordIndexes = parts
    .map((part, index) => ({ index, key: echoKey(part) }))
    .filter((entry) => entry.key.length > 0);

  let start = -1;

  for (let i = 0; i + wanted.length <= wordIndexes.length; i += 1) {
    const run = wordIndexes.slice(i, i + wanted.length);
    if (run.every((entry, offset) => entry.key === wanted[offset])) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return text;
  }

  const from = wordIndexes[start]?.index ?? 0;
  const to = wordIndexes[start + wanted.length - 1]?.index ?? from;

  return (
    <>
      {parts.slice(0, from).join("")}
      <mark className="rounded-sm bg-destructive/25 px-0.5 text-foreground">
        {parts.slice(from, to + 1).join("")}
      </mark>
      {parts.slice(to + 1).join("")}
    </>
  );
}

type HeldNotePanelProps = {
  /** Drop the held line into the note textarea as a draft (the "it's 90% right" path). */
  onUseAsDraft: (note: string) => void;
  trackId: string;
};

export function HeldNotePanel({ onUseAsDraft, trackId }: HeldNotePanelProps) {
  const queryClient = useQueryClient();
  // A secondary, on-demand panel: the board's loader does not carry the ledger, and most
  // findings have no held note, so this is its own unseeded query rather than a payload
  // every board row pays for.
  const { data } = useQuery({
    queryFn: () => fetchHeldNote(trackId),
    queryKey: REJECTIONS_KEY(trackId),
    refetchOnWindowFocus: true,
  });

  const held = data?.rejections[0];
  const gate = data?.gate;
  const heldId = held?.id;

  const rule = useMutation({
    mutationFn: (resolution: "accepted" | "discarded") => {
      if (!heldId) {
        throw new Error("Could not rule on the held note.");
      }

      return resolveHeldNote(heldId, resolution);
    },
    onSuccess: async () => {
      // The ruling changes the finding's note AND clears a row off the attention queue.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: REJECTIONS_KEY(trackId) }),
        queryClient.invalidateQueries({ queryKey: ["admin", "board"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "attention"] }),
      ]);
    },
  });

  if (!held || !gate) {
    return null;
  }

  const overlapPercent = Math.round(held.overlap * 100);
  const gateOverlapPercent = Math.round(held.maxOverlap * 100);
  const liftedWords = held.phrase ? held.phrase.split(" ").length : 0;
  // The gate has been retuned since this note was judged — say so, rather than showing him
  // a threshold that is not the one that actually rejected it.
  const retuned =
    gate.maxOverlap !== held.maxOverlap || gate.minPhraseWords !== held.minPhraseWords;

  return (
    <section className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">The echo gate held this back</h3>
        {held.attempts > 1 ? (
          <Badge variant="outline">
            bounced {held.attempts}
            {"×"}
          </Badge>
        ) : undefined}
      </header>

      <p className="text-xs text-muted-foreground">
        It wasn{"’"}t stored, and it wasn{"’"}t thrown away. Read it and decide.
      </p>

      <blockquote className="border-l-2 border-border pl-3 text-sm leading-relaxed">
        {markPhrase(held.note, held.phrase)}
      </blockquote>

      <Separator />

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {held.phrase ? "It lifts a run straight from" : "It reuses the words of"}{" "}
          <span className="font-mono text-foreground">{held.neighborLogId ?? "a neighbour"}</span>,
          the finding next to it in vibe space:
        </p>
        {held.neighborNote ? (
          <blockquote className="border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
            {markPhrase(held.neighborNote, held.phrase)}
          </blockquote>
        ) : undefined}
      </div>

      {/* The score next to the threshold it was judged against — a number with nothing to
          compare it to is not evidence, and evidence is the entire point of this panel. */}
      <p className="text-xs tabular-nums text-muted-foreground">
        {liftedWords > 0
          ? `lifted ${liftedWords} words · gate at ${held.minPhraseWords}`
          : `overlap ${overlapPercent}% · gate at ${gateOverlapPercent}%`}
        {retuned ? " · the gate has been retuned since" : ""}
      </p>

      {/* Two canon rails meet here. The One Sun budget (DESIGN.md): the dialog's single gold
          primary is "Save note", so none of these may be gold. The disclosure law: a
          destructive act is DEMOTED, never the loudest thing on the surface — so "Bin it" is
          a ghost, not a red slab. That leaves "Keep it" as the outlined lead (it is the
          one-action overrule the row exists for), with "Edit it" — in practice the commonest
          ruling, since the model is usually right but for the clause it borrowed — beside it. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={rule.isPending}
          onClick={() => rule.mutate("accepted")}
          size="sm"
          variant="outline"
        >
          {rule.isPending ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
          ) : (
            <CheckIcon aria-hidden="true" weight="bold" />
          )}
          Keep it
        </Button>
        <Button onClick={() => onUseAsDraft(held.note)} size="sm" variant="outline">
          <PencilSimpleIcon aria-hidden="true" weight="bold" />
          Edit it
        </Button>
        <Button
          disabled={rule.isPending}
          onClick={() => rule.mutate("discarded")}
          size="sm"
          variant="ghost"
        >
          <TrashIcon aria-hidden="true" weight="bold" />
          Bin it
        </Button>
      </div>

      {rule.error ? (
        <p className="text-sm text-destructive">{(rule.error as Error).message}</p>
      ) : undefined}
    </section>
  );
}

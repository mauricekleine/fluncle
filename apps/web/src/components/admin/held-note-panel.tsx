import { CheckIcon, CircleNotchIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type NoteRejection } from "@fluncle/contracts";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Separator } from "@fluncle/ui/components/separator";

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

function echoKey(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function markPhrase(text: string, phrase: string) {
  const wanted = phrase.split(" ").filter(Boolean).map(echoKey);

  if (wanted.length === 0) {
    return text;
  }

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
  onUseAsDraft: (note: string) => void;
  trackId: string;
};

export function HeldNotePanel({ onUseAsDraft, trackId }: HeldNotePanelProps) {
  const queryClient = useQueryClient();

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

      <p className="text-xs tabular-nums text-muted-foreground">
        {liftedWords > 0
          ? `lifted ${liftedWords} words · gate at ${held.minPhraseWords}`
          : `overlap ${overlapPercent}% · gate at ${gateOverlapPercent}%`}
        {retuned ? " · the gate has been retuned since" : ""}
      </p>

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

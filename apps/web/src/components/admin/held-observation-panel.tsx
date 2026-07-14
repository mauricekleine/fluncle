import { CheckIcon, CircleNotchIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ObservationRejection } from "@fluncle/contracts";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Separator } from "@fluncle/ui/components/separator";
import { markPhrase } from "./held-note-panel";

// THE HELD OBSERVATION — the observation echo gate's rejection, made readable. The spoken
// sibling of the held-note panel, and the same design: the script the model wrote next to the
// neighbour script it echoed, the lifted words marked in BOTH, and the score beside the
// threshold it was judged against. Evidence, not a verdict.
//
// Two rulings (one fewer than the note's — there is no script textarea to edit into):
// RENDER IT (the operator overrules the gate; the held script goes through the same render
// path the observe endpoint uses — this SPENDS a Cartesia render, which is why the ruling is
// operator-tier), or BIN IT (the gate was right; the finding stays unvoiced and the sweep is
// free to try a colder read next tick).

const REJECTIONS_KEY = (trackId: string) => ["admin", "observation-rejections", trackId] as const;

type HeldObservationResponse = {
  gate: { maxOverlap: number; minPhraseWords: number };
  rejections: ObservationRejection[];
};

async function fetchHeldObservation(trackId: string): Promise<HeldObservationResponse> {
  const response = await fetch(
    `/api/v1/admin/observation-rejections?trackId=${encodeURIComponent(trackId)}`,
  );

  if (!response.ok) {
    throw new Error("Could not read the held observation.");
  }

  return (await response.json()) as HeldObservationResponse;
}

async function resolveHeldObservation(
  id: string,
  resolution: "accepted" | "discarded",
): Promise<void> {
  const response = await fetch(
    `/api/v1/admin/observation-rejections/${encodeURIComponent(id)}/resolve`,
    {
      body: JSON.stringify({ resolution }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Could not rule on the held observation.",
    );
  }
}

type HeldObservationPanelProps = {
  trackId: string;
};

export function HeldObservationPanel({ trackId }: HeldObservationPanelProps) {
  const queryClient = useQueryClient();
  // A secondary, on-demand panel (the held-note precedent): the board's loader does not carry
  // the ledger, and most findings have no held observation, so this is its own unseeded query.
  const { data } = useQuery({
    queryFn: () => fetchHeldObservation(trackId),
    queryKey: REJECTIONS_KEY(trackId),
    refetchOnWindowFocus: true,
  });

  const held = data?.rejections[0];
  const gate = data?.gate;
  const heldId = held?.id;

  const rule = useMutation({
    mutationFn: (resolution: "accepted" | "discarded") => {
      if (!heldId) {
        throw new Error("Could not rule on the held observation.");
      }

      return resolveHeldObservation(heldId, resolution);
    },
    onSuccess: async () => {
      // A ruling can render an observation onto the finding AND clears a queue row.
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
  // The gate has been retuned since this script was judged — say so, rather than showing a
  // threshold that is not the one that actually rejected it.
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
        It wasn{"’"}t rendered (no money spent), and it wasn{"’"}t thrown away. Read it and decide.
      </p>

      <blockquote className="border-l-2 border-border pl-3 text-sm leading-relaxed">
        {markPhrase(held.script, held.phrase)}
      </blockquote>

      <Separator />

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {held.phrase ? "It lifts a run straight from" : "It reuses the words of"}{" "}
          <span className="font-mono text-foreground">{held.neighborLogId ?? "a neighbour"}</span>,
          the finding next to it in vibe space:
        </p>
        {held.neighborScript ? (
          <blockquote className="border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
            {markPhrase(held.neighborScript, held.phrase)}
          </blockquote>
        ) : undefined}
      </div>

      {/* The score next to the threshold it was judged against — the held-note rule. */}
      <p className="text-xs tabular-nums text-muted-foreground">
        {liftedWords > 0
          ? `lifted ${liftedWords} words · gate at ${held.minPhraseWords}`
          : `overlap ${overlapPercent}% · gate at ${gateOverlapPercent}%`}
        {retuned ? " · the gate has been retuned since" : ""}
      </p>

      {/* One Sun + the disclosure law, as on the held note: the overrule leads as an outline
          (it costs a render, so the label says what it does), the destructive act is a ghost. */}
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
          Render it
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

import { WaveTriangleIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { type MixReason } from "@fluncle/contracts";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { Textarea } from "@fluncle/ui/components/textarea";
import { ensureAdmin } from "@/lib/admin-guard";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { isLogId } from "@/lib/log-id";
import { mixReasonLabel } from "@/lib/mix-set";

export const Route = createFileRoute("/admin/mixable-order")({
  beforeLoad: () => ensureAdmin(),
  component: MixableOrderPage,
});

type MixOrderStop = {
  artists: string[];
  bpm?: number;
  flagged: boolean;
  key?: string;
  logId: string;
  title: string;
  transitionReason?: MixReason;
  transitionScore?: number;
};

type MixableOrderResult = {
  algorithm: "held-karp" | "greedy-2opt";
  ok: true;
  order: MixOrderStop[];
  totalCost: number;
};

function parsePool(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function MixableOrderPage() {
  const [pool, setPool] = useState("");
  const [seed, setSeed] = useState("");

  const ids = useMemo(() => parsePool(pool), [pool]);
  const invalid = useMemo(() => ids.filter((id) => !isLogId(id)), [ids]);
  const canPropose = ids.length >= 2 && ids.length <= 64 && invalid.length === 0;

  const propose = useMutation({
    mutationFn: async (): Promise<MixableOrderResult> => {
      const params = new URLSearchParams({ ids: ids.join(",") });

      if (seed.trim()) {
        params.set("seed", seed.trim());
      }

      const response = await fetch(`/api/v1/admin/tracks/mixable-order?${params.toString()}`);
      const body = (await response.json()) as MixableOrderResult & { message?: string };

      if (!response.ok) {
        throw new Error(body.message ?? "Could not order the pool.");
      }

      return body;
    },
    onError: (error: Error) => toast(error.message),
  });

  const order = propose.data?.order ?? [];

  const copyTracklist = async () => {
    const text = order.map((stop) => `${stop.artists.join(", ")} — ${stop.title}`).join("\n");

    try {
      await navigator.clipboard.writeText(text);
      toast("Tracklist copied. Paste it into Rekordbox.");
    } catch {
      toast("Could not copy the tracklist.");
    }
  };

  const subtitle =
    ids.length === 0
      ? "Paste a pool of Log IDs to order"
      : invalid.length > 0
        ? `Not a Log ID: ${invalid.join(", ")}`
        : `${ids.length} findings${ids.length > 64 ? " (max 64)" : ""}`;

  return (
    <AdminShell
      headerActions={
        <Button disabled={!canPropose || propose.isPending} onClick={() => propose.mutate()}>
          <WaveTriangleIcon className="size-4" />
          Propose an order
        </Button>
      }
      subtitle={subtitle}
      title="Dream-weaver"
    >
      <div className="flex flex-col gap-4 p-3 sm:p-4">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="mix-pool">
            The pool: Log IDs, separated by spaces, commas, or new lines (2–64)
          </label>
          <Textarea
            id="mix-pool"
            onChange={(event) => setPool(event.target.value)}
            placeholder="004.7.2I 011.1.6E 019.8.6S …"
            rows={4}
            value={pool}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="mix-seed">
            Open on (optional): pin the first track by Log ID
          </label>
          <Input
            className="max-w-xs"
            id="mix-seed"
            onChange={(event) => setSeed(event.target.value)}
            placeholder="004.7.2I"
            value={seed}
          />
        </div>

        {order.length > 0 ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                A smooth chain, not an energy-shaped set. Advisory input for Rekordbox.
              </p>
              <Button onClick={() => void copyTracklist()} variant="outline">
                Copy tracklist
              </Button>
            </div>
            <ObjectList>
              {order.map((stop, index) => (
                <ObjectRow
                  key={stop.logId}
                  trailing={
                    <div className="text-right text-xs text-muted-foreground tabular-nums">
                      {index === 0 ? (
                        <span>opens</span>
                      ) : stop.flagged ? (
                        <span className="text-destructive">sparse join</span>
                      ) : (
                        <span>
                          {stop.transitionReason ? mixReasonLabel(stop.transitionReason) : "—"}
                        </span>
                      )}
                    </div>
                  }
                >
                  <ObjectLead
                    coordinate={stop.logId}
                    leading={<ObjectGlyph icon={WaveTriangleIcon} />}
                    subtitle={
                      <span>
                        {[stop.key, stop.bpm ? `${Math.round(stop.bpm)} bpm` : undefined]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    }
                    title={`${index + 1}. ${stop.artists.join(", ")} — ${stop.title}`}
                  />
                </ObjectRow>
              ))}
            </ObjectList>
          </section>
        ) : null}
      </div>
    </AdminShell>
  );
}

import {
  ArrowSquareOutIcon,
  CassetteTapeIcon,
  CircleNotchIcon,
  ListChecksIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { readError } from "@/lib/read-error";
import { beatportSearchUrl } from "@/lib/beatport";
import { albumCoverAtSize } from "@/lib/media";
import { mixtapeDisplayTitle } from "@/lib/mixtapes";
import { type MixtapeMembership } from "@/lib/server/mixtapes";
import { type PlanMembership } from "@/lib/server/recordings";

type DialogTrack = {
  albumImageUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
};

export type PlanTargetCue = {
  artistsText?: string;
  findingId?: string;
  startMs?: number;
  titleText?: string;
};

export type PlanTarget = {
  cues: PlanTargetCue[];
  id: string;
  title: string;
};

export function AddToPlanDialog({
  memberships,
  onAdded,
  onOpenChange,
  planMemberships,
  plans,
  plansLoading,
  track,
}: {
  memberships: MixtapeMembership[];
  onAdded: (planId: string) => void;
  onOpenChange: (open: boolean) => void;
  planMemberships: PlanMembership[];
  plans: PlanTarget[];
  plansLoading: boolean;
  track: DialogTrack | null;
}) {
  const [busyId, setBusyId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const busy = creating || busyId !== undefined;

  const addTo = async (plan: PlanTarget) => {
    if (!track) {
      return;
    }
    setBusyId(plan.id);
    setError(undefined);
    try {
      await appendCue(plan, track);
      onAdded(plan.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const addToNew = async () => {
    if (!track) {
      return;
    }
    setCreating(true);
    setError(undefined);
    try {
      const created = await createPlan();
      await appendCue({ cues: [], id: created, title: "" }, track);
      onAdded(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog onOpenChange={(next) => !busy && onOpenChange(next)} open={track !== null}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add to a plan</DialogTitle>
          <DialogDescription>
            Pencil this finding into a plan for an upcoming set, or start a new one.
          </DialogDescription>
        </DialogHeader>

        {track ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              {track.albumImageUrl ? (
                <img
                  alt=""
                  className="size-9 shrink-0 rounded-sm border border-border object-cover"
                  src={albumCoverAtSize(track.albumImageUrl, "small")}
                />
              ) : (
                <div className="track-artwork-fallback size-9 shrink-0 rounded-sm border border-border" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">
                {track.artists.join(", ")} — {track.title}
              </span>
              <a
                className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                href={beatportSearchUrl(track.artists, track.title)}
                rel="noreferrer"
                target="_blank"
                title="Search this on Beatport"
              >
                Beatport
                <ArrowSquareOutIcon aria-hidden="true" className="size-3" />
              </a>
            </div>

            {memberships.length > 0 || planMemberships.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-bold text-muted-foreground">Already on</p>
                <ul className="space-y-0.5">
                  {memberships.map((membership) => {
                    const name = mixtapeDisplayTitle(membership.title) || "Mixtape";
                    const label = membership.logId ? `${membership.logId} · ${name}` : name;
                    return (
                      <li
                        className="flex items-center gap-1.5 text-sm text-muted-foreground"
                        key={membership.mixtapeId}
                      >
                        <CassetteTapeIcon aria-hidden="true" className="size-3.5 shrink-0" />
                        {membership.status === "published" && membership.logId ? (
                          <Link
                            className="truncate hover:text-foreground hover:underline"
                            params={{ logId: membership.logId }}
                            rel="noreferrer"
                            target="_blank"
                            to="/log/$logId"
                          >
                            {label}
                          </Link>
                        ) : (
                          <span className="truncate">{label}</span>
                        )}
                      </li>
                    );
                  })}
                  {planMemberships.map((membership) => (
                    <li
                      className="flex items-center gap-1.5 text-sm text-muted-foreground"
                      key={membership.recordingId}
                    >
                      <ListChecksIcon aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="truncate font-mono text-xs">{membership.title}</span>
                      <span className="shrink-0 text-xs">(plan)</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              <p className="text-xs font-bold text-muted-foreground">Plans</p>

              {plansLoading ? (
                <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                  Loading plans…
                </p>
              ) : plans.length > 0 ? (
                <ul className="space-y-1.5">
                  {plans.map((plan) => {
                    const pencilled = plan.cues.some((cue) => cue.findingId === track.trackId);

                    const bangerCount = plan.cues.filter((cue) => cue.findingId).length;
                    return (
                      <li key={plan.id}>
                        <Button
                          className="w-full justify-start gap-2.5"
                          disabled={busy || pencilled}
                          onClick={() => void addTo(plan)}
                        >
                          {busyId === plan.id ? (
                            <CircleNotchIcon
                              aria-hidden="true"
                              className="animate-spin"
                              weight="bold"
                            />
                          ) : (
                            <ListChecksIcon aria-hidden="true" weight="fill" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-left font-mono text-sm">
                            {plan.title}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums opacity-80">
                            {pencilled
                              ? "Pencilled in"
                              : `${bangerCount} banger${bangerCount === 1 ? "" : "s"}`}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No plans yet. Start the first one.</p>
              )}

              <Button
                className="w-full justify-start"
                disabled={busy}
                onClick={() => void addToNew()}
                variant={plans.length === 0 ? "default" : "outline"}
              >
                {creating ? (
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                ) : (
                  <PlusIcon aria-hidden="true" weight="bold" />
                )}
                New plan
              </Button>
            </div>

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

async function createPlan(): Promise<string> {
  const response = await fetch("/api/v1/admin/recordings", {
    body: JSON.stringify({ kind: "plan" }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { recording?: { id?: string } };
  const id = body.recording?.id;
  if (!id) {
    throw new Error("The new plan came back without an id.");
  }
  return id;
}

async function appendCue(plan: PlanTarget, track: DialogTrack): Promise<void> {
  const response = await fetch(`/api/v1/admin/recordings/${encodeURIComponent(plan.id)}/cues`, {
    body: JSON.stringify({
      cues: [
        ...plan.cues,
        {
          artistsText: track.artists.join(", "),
          findingId: track.trackId,
          titleText: track.title,
        },
      ],
    }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

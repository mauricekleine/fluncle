import { ArrowDownIcon, ArrowUpIcon, LinkSimpleIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { type FeedItem, type MixableCandidate, type TrackListItem } from "@fluncle/contracts";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@fluncle/ui/components/command";
import { MixPlayer } from "@/components/mix/mix-player";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { mixReasonLabel, serializeSet } from "@/lib/mix-set";

// Product A's plate (RFC mixability-engine §3): one printed logbook page — the crew
// taking the decks with Fluncle's findings. NOT a SaaS builder. The design invariants
// (§3.0) are gates: exactly ONE gold primary (Copy set link); no numeric score ever
// reaches the crew (only the reason chip); a builder-row variant (not TrackRow's
// stretched link); reorder via keyboard up/down (no drag dependency). Copy PENDING the
// morning review (Decision 5).

const artworkUrl = (finding: TrackListItem): string | undefined =>
  spotifyAlbumImageAtSize(finding.albumImageUrl, "small");

// A builder row — the TrackRow grid skeleton (coordinate, 3.25rem artwork, title, a
// chip row) WITHOUT the stretched navigation link, so Add / remove / reorder can each
// own their own hit target (§3.0 invariant 3).
function BuilderRow({
  actions,
  chip,
  finding,
}: {
  actions?: React.ReactNode;
  chip?: React.ReactNode;
  finding: TrackListItem;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex flex-1 items-center gap-3">
        <TrackArtwork alt="" src={artworkUrl(finding)} />
        <div className="min-w-0 flex-1">
          {finding.logId ? (
            // The coordinate in the canon numeric face — Oxanium tabular at the Track
            // Row's size (The Tabular Rule; mono is reserved for machine surfaces).
            <Link
              className="track-log-id track-log-id-link block truncate"
              params={{ logId: finding.logId }}
              to="/log/$logId"
            >
              {finding.logId}
            </Link>
          ) : null}
          <p className="truncate text-sm font-medium">{finding.title}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">{finding.artists.join(", ")}</span>
            {chip}
          </div>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </li>
  );
}

async function fetchMixable(tailLogId: string, exclude: string[]): Promise<MixableCandidate[]> {
  const params = new URLSearchParams({ limit: "12" });

  if (exclude.length > 0) {
    params.set("exclude", exclude.join(","));
  }

  const response = await fetch(
    `/api/v1/tracks/${encodeURIComponent(tailLogId)}/mixable?${params.toString()}`,
  );

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { findings?: MixableCandidate[] };

  return body.findings ?? [];
}

async function fetchFindingPool(): Promise<TrackListItem[]> {
  const response = await fetch("/api/v1/tracks?limit=48");

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { tracks?: FeedItem[] };

  return (body.tracks ?? []).filter(
    (item): item is TrackListItem => item.type !== "mixtape" && Boolean(item.logId),
  );
}

export function MixBuilder({
  initialChain,
  onPromote,
  onSetChange,
  readOnly,
}: {
  initialChain: TrackListItem[];
  /** Read-only → editable ("Chain your own set from here"). */
  onPromote: () => void;
  /** Sync the ordered chain to the `?set=` URL (masked replace, no loader rerun). */
  onSetChange: (logIds: string[]) => void;
  readOnly: boolean;
}) {
  const [chain, setChain] = useState<TrackListItem[]>(initialChain);

  const chainLogIds = useMemo(
    () => chain.map((finding) => finding.logId).filter((id): id is string => Boolean(id)),
    [chain],
  );

  const mutate = useCallback(
    (next: TrackListItem[]) => {
      setChain(next);
      onSetChange(next.map((finding) => finding.logId).filter((id): id is string => Boolean(id)));
    },
    [onSetChange],
  );

  const add = useCallback(
    (finding: TrackListItem) => {
      if (chain.some((existing) => existing.logId === finding.logId)) {
        return;
      }

      mutate([...chain, finding]);
    },
    [chain, mutate],
  );

  const remove = useCallback(
    (logId: string) => mutate(chain.filter((finding) => finding.logId !== logId)),
    [chain, mutate],
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= chain.length) {
        return;
      }

      const next = [...chain];
      const [moved] = next.splice(from, 1);

      if (moved) {
        next.splice(to, 0, moved);
        mutate(next);
      }
    },
    [chain, mutate],
  );

  const tail = chainLogIds[chainLogIds.length - 1];

  // The rail off the chain's tail, excluding the whole chain server-side (§3.1).
  const { data: candidates = [] } = useQuery({
    enabled: !readOnly && Boolean(tail),
    queryFn: () => (tail ? fetchMixable(tail, chainLogIds) : Promise.resolve([])),
    queryKey: ["mixable", tail, chainLogIds.length],
  });

  const share = useCallback(async () => {
    const url = `${siteUrl}/mix?set=${serializeSet(chainLogIds)}&view=play`;

    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "A Fluncle mix", url });
      } else {
        await navigator.clipboard.writeText(url);
        toast("Set link copied. Send it to the crew.");
      }
    } catch {
      // A cancelled share sheet is not an error; a clipboard failure gets the fallback.
      try {
        await navigator.clipboard.writeText(url);
        toast("Set link copied. Send it to the crew.");
      } catch {
        toast("Could not copy the link.");
      }
    }
  }, [chainLogIds]);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      {chain.length === 0 ? (
        <MixPicker onPick={add} />
      ) : (
        <>
          {/* The chain, a flat plate-field pane on the plate (One Pane). */}
          <ol className="plate-field m-0 list-none divide-y divide-border rounded-md border border-border p-0">
            {chain.map((finding, position) => (
              <BuilderRow
                actions={
                  readOnly ? undefined : (
                    <>
                      <Button
                        aria-label="Move up"
                        disabled={position === 0}
                        onClick={() => move(position, position - 1)}
                        size="icon"
                        variant="ghost"
                      >
                        <ArrowUpIcon className="size-4" />
                      </Button>
                      <Button
                        aria-label="Move down"
                        disabled={position === chain.length - 1}
                        onClick={() => move(position, position + 1)}
                        size="icon"
                        variant="ghost"
                      >
                        <ArrowDownIcon className="size-4" />
                      </Button>
                      <Button
                        aria-label={`Take ${finding.title} out of the set`}
                        onClick={() => finding.logId && remove(finding.logId)}
                        size="icon"
                        variant="ghost"
                      >
                        <XIcon className="size-4" />
                      </Button>
                    </>
                  )
                }
                finding={finding}
                key={finding.logId ?? finding.trackId}
              />
            ))}
          </ol>

          <MixPlayer chain={chain} />

          {readOnly ? (
            <Button className="self-start" onClick={onPromote} variant="default">
              Chain your own set from here
            </Button>
          ) : (
            <Button className="self-start" onClick={() => void share()} variant="default">
              <LinkSimpleIcon className="size-4" />
              Copy set link
            </Button>
          )}
        </>
      )}

      {!readOnly && chain.length > 0 ? (
        <section aria-label="What mixes out of this">
          {/* A small bold label — never uppercase-tracked (a DESIGN.md Don't). */}
          <h2 className="mb-2 px-1 text-xs font-bold text-muted-foreground">What keys up next</h2>
          {candidates.length > 0 ? (
            <ul className="plate-field m-0 list-none divide-y divide-border rounded-md border border-border p-0">
              {candidates.map((candidate) => (
                <BuilderRow
                  actions={
                    <Button
                      aria-label={`Add ${candidate.title} to the set`}
                      onClick={() => add(candidate)}
                      size="icon"
                      variant="ghost"
                    >
                      <PlusIcon className="size-4" />
                    </Button>
                  }
                  chip={<Badge variant="secondary">{mixReasonLabel(candidate.reason)}</Badge>}
                  finding={candidate}
                  key={candidate.logId ?? candidate.trackId}
                />
              ))}
            </ul>
          ) : (
            <p className="px-1 text-sm text-muted-foreground">
              Nothing keys up cleanly to this one yet. Quiet sector tonight.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}

// The cold-start picker — a command-combobox over the recent findings (§3.3.1). Pick
// one to seed the chain; the rail takes over from there.
function MixPicker({ onPick }: { onPick: (finding: TrackListItem) => void }) {
  const { data: pool = [] } = useQuery({
    queryFn: fetchFindingPool,
    queryKey: ["mix-pool"],
    staleTime: 60_000,
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Pick a finding to open with. The archive will tell you what keys up next.
      </p>
      <Command className="rounded-lg border border-border">
        <CommandInput placeholder="Search the findings…" />
        <CommandList>
          <CommandEmpty>No finding by that name.</CommandEmpty>
          <CommandGroup>
            {pool.map((finding) => (
              <CommandItem
                key={finding.logId ?? finding.trackId}
                onSelect={() => onPick(finding)}
                value={`${finding.artists.join(" ")} ${finding.title} ${finding.logId ?? ""}`}
              >
                <span className="truncate">
                  {finding.artists.join(", ")} — {finding.title}
                </span>
                <span className="track-log-id ml-auto shrink-0">{finding.logId}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

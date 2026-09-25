import { useMemo, useState } from "react";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { cn } from "@/lib/utils";
import { AddPill, RecCover, RecSeal, TrackReadout } from "./rec-rows";
import {
  type FrontierEditionDetail,
  type FrontierEditionTrack,
  type RecSeedItem,
  SEED_CAP,
  skippedSeedsLine,
} from "./shared";

export function EditionShelf({
  latest,
  onAdd,
  onRemove,
  seeds,
  stale,
}: {
  latest: FrontierEditionDetail | null;
  onAdd: (trackId: string) => Promise<void>;
  onRemove: (trackId: string) => Promise<void>;
  seeds: RecSeedItem[];
  stale: boolean;
}) {
  const { notation } = useKeyNotation();
  const [pending, setPending] = useState<Set<string>>(new Set());

  const pickedIds = useMemo(() => new Set(seeds.map((seed) => seed.trackId)), [seeds]);

  const atCap = seeds.length >= SEED_CAP;

  const findings = useMemo(
    () => latest?.tracks.filter((track) => track.slot === "finding") ?? [],
    [latest],
  );
  const catalogue = useMemo(
    () => latest?.tracks.filter((track) => track.slot === "catalogue") ?? [],
    [latest],
  );
  const seedsSkipped = latest?.summary.seedsSkipped ?? [];

  async function pick(trackId: string, picked: boolean) {
    setPending((current) => new Set(current).add(trackId));

    try {
      await (picked ? onRemove(trackId) : onAdd(trackId));
    } finally {
      setPending((current) => {
        const next = new Set(current);

        next.delete(trackId);

        return next;
      });
    }
  }

  return (
    <section className="rec-recommended">
      <h2>Recommended</h2>

      <p aria-live="polite" className="rec-muted rec-skipped">
        {stale ? "New picks noted. They steer Friday's refresh." : null}
      </p>

      {latest && latest.tracks.length > 0 ? (
        <ol className="rec-shelf">
          {findings.map((track) => {
            const picked = pickedIds.has(track.trackId);

            return (
              <EditionRow
                busy={pending.has(track.trackId)}
                disabled={!picked && atCap}
                key={track.trackId}
                notation={notation}
                onPick={() => void pick(track.trackId, picked)}
                picked={picked}
                track={track}
              />
            );
          })}
          {catalogue.map((track) => {
            const picked = pickedIds.has(track.trackId);

            return (
              <EditionRow
                busy={pending.has(track.trackId)}
                disabled={!picked && atCap}
                key={track.trackId}
                notation={notation}
                onPick={() => void pick(track.trackId, picked)}
                picked={picked}
                track={track}
              />
            );
          })}
        </ol>
      ) : (
        <div className="rec-recommended-ghost">
          <ol aria-hidden className="rec-shelf">
            {[0, 1, 2, 3, 4].map((row) => (
              <li className="rec-ghost-row" key={row}>
                <span className="rec-ghost-cover" />
                <span className="rec-ghost-lines">
                  <span className="rec-ghost-line" />
                  <span className="rec-ghost-line rec-ghost-line--short" />
                </span>
              </li>
            ))}
          </ol>

          <p className="rec-muted">Couldn&rsquo;t load your saved picks. Refresh the page.</p>
        </div>
      )}

      {seedsSkipped.length > 0 && latest && latest.tracks.length > 0 ? (
        <p className="rec-muted rec-skipped">{skippedSeedsLine(seedsSkipped.length)}</p>
      ) : null}
    </section>
  );
}

function EditionRow({
  busy,
  disabled,
  notation,
  onPick,
  picked,
  track,
}: {
  busy: boolean;
  disabled: boolean;
  notation: KeyNotation;
  onPick: () => void;
  picked: boolean;
  track: FrontierEditionTrack;
}) {
  const trackLine = `${track.artists.join(", ")} — ${track.title}`;

  return (
    <li className={cn("rec-row", track.slot === "catalogue" && "rec-row--unlit")}>
      <RecCover url={track.imageUrl} />

      <span className="rec-row-body min-w-0">
        <span className="rec-row-title">{trackLine}</span>
        <span className="rec-row-chips">
          {track.slot === "finding" && track.logId ? (
            <RecSeal logId={track.logId} trackLine={trackLine} />
          ) : null}
          <TrackReadout
            bpm={track.bpm}
            durationMs={track.durationMs}
            musicalKey={track.key}
            notation={notation}
          />
        </span>
      </span>

      <AddPill
        busy={busy}
        disabled={disabled}
        label={picked ? `Remove ${trackLine} from your picks` : `Add ${trackLine} to your picks`}
        onPick={onPick}
        picked={picked}
      />
    </li>
  );
}

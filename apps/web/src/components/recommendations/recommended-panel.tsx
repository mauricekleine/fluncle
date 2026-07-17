// THE RECOMMENDED PANEL — what the engine lines up from your picks, below the tracklist
// (Spotify's own playlist page order). Every row wears the EXACT SAME anatomy — cover,
// the fused Artist — Title, the Stardust imprint, the instrument readout, the Add pill —
// because this is a workbench, not a billboard: no notes, no coordinates column, no
// section labels. The register split rides the LIGHT, never the layout (the Unlit Rule):
// a finding catches the gold veil on hover and wears the Fluncle seal (the gold
// coordinate pill in its chips row, a link to /log/<id>); a catalogue cut hovers cold on
// the Dust Veil with a cold cover. Endorse a row and it moves into the tracklist — a
// seeded track is never recommended back, so the shelf reshuffles on the refetch.
//
// With zero picks the shelf renders its ghost — skeleton rows and the one line that says
// how it wakes.

import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { usePreviewPlayer } from "@/lib/preview-player";
import { cn } from "@/lib/utils";
import { AddPill, RecCover, RecImprint, RecSeal, TrackReadout } from "./rec-rows";
import {
  type RecommendationCatalogueItem,
  type RecommendationFindingItem,
  type RecSeedItem,
  SEED_CAP,
} from "./shared";

export function RecommendedPanel({
  catalogue,
  findings,
  onAdd,
  onRemove,
  seeds,
  seedsSkipped,
}: {
  catalogue: RecommendationCatalogueItem[];
  findings: RecommendationFindingItem[];
  onAdd: (trackId: string) => Promise<void>;
  onRemove: (trackId: string) => Promise<void>;
  seeds: RecSeedItem[];
  seedsSkipped: string[];
}) {
  const { notation } = useKeyNotation();
  const [pending, setPending] = useState<Set<string>>(new Set());

  const pickedIds = useMemo(() => new Set(seeds.map((seed) => seed.trackId)), [seeds]);
  // At the cap an UN-picked pill disables (the cap discipline); a picked one always stays
  // toggle-removable, so the reader can trade one pick for another without a dead end.
  const atCap = seeds.length >= SEED_CAP;
  const hasPicks = seeds.length > 0;
  const hasAny = findings.length > 0 || catalogue.length > 0;

  // The pick gesture, pending-guarded per track — a click adds when un-picked, removes when
  // picked (the toggle), and the door refetches both the picks and the recommendations.
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

      {hasAny ? (
        <ol className="rec-shelf">
          {findings.map((finding) => {
            const picked = pickedIds.has(finding.trackId);

            return (
              <FindingRow
                busy={pending.has(finding.trackId)}
                disabled={!picked && atCap}
                finding={finding}
                key={finding.trackId}
                notation={notation}
                onPick={() => void pick(finding.trackId, picked)}
                picked={picked}
              />
            );
          })}
          {catalogue.map((track) => {
            const picked = pickedIds.has(track.trackId);

            return (
              <CatalogueRow
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
      ) : hasPicks ? (
        <p className="rec-muted">
          {seedsSkipped.length > 0
            ? "Fluncle hasn't got the audio for your picks yet, so there's nothing to line up against them. Give it a day, or point him at a few more."
            : "Nothing lined up yet. Add a few more picks and Fluncle goes digging."}
        </p>
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
          <p className="rec-muted">Pick a few tracks and the finds line up here.</p>
        </div>
      )}

      {seedsSkipped.length > 0 && hasAny ? (
        <p className="rec-muted rec-skipped">
          {seedsSkipped.length === 1
            ? "One of your picks isn't steering yet. Fluncle hasn't got its audio."
            : `${seedsSkipped.length} of your picks aren't steering yet. Fluncle hasn't got their audio.`}
        </p>
      ) : null}
    </section>
  );
}

/**
 * A recommended finding — the same row anatomy as every other row, the register carried
 * by the LIGHT and the SEAL: the gold coordinate pill in the chips row (a link to
 * /log/<id>), the gold veil on hover, the preview control on the cover. No note, no
 * lead column — the workbench shows the music; the WHY lives behind the seal.
 */
function FindingRow({
  busy,
  disabled,
  finding,
  notation,
  onPick,
  picked,
}: {
  busy: boolean;
  disabled: boolean;
  finding: RecommendationFindingItem;
  notation: KeyNotation;
  onPick: () => void;
  picked: boolean;
}) {
  const preview = usePreviewPlayer(finding.trackId);
  const trackLine = `${finding.artists.join(", ")} — ${finding.title}`;

  return (
    <li className="rec-row">
      <span className="preview-art rec-cover-wrap">
        <RecCover url={finding.imageUrl} />
        <button
          aria-label={
            preview.isActive
              ? `Pause the preview of ${finding.title}`
              : `Play the preview of ${finding.title}`
          }
          aria-pressed={preview.isActive}
          className="preview-art-btn"
          onClick={preview.toggle}
          type="button"
        >
          {preview.isActive ? (
            <PauseIcon aria-hidden="true" className="size-4" weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" className="size-4" weight="fill" />
          )}
        </button>
      </span>

      <span className="rec-row-body min-w-0">
        <span className="rec-row-title">{trackLine}</span>
        <RecImprint label={finding.label} year={finding.year} />
        <span className="rec-row-chips">
          <RecSeal logId={finding.logId} trackLine={trackLine} />
          <TrackReadout
            bpm={finding.bpm}
            durationMs={finding.durationMs}
            musicalKey={finding.key}
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

/**
 * A recommended catalogue cut — the same row anatomy, cold: the Dust Veil hover, the
 * desaturated cover, the ink deferring at rest (the Unlit Rule), and no seal.
 */
function CatalogueRow({
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
  track: RecommendationCatalogueItem;
}) {
  const trackLine = `${track.artists.join(", ")} — ${track.title}`;

  return (
    <li className={cn("rec-row", "rec-row--unlit")}>
      <RecCover url={track.imageUrl} />

      <span className="rec-row-body min-w-0">
        <span className="rec-row-title">{trackLine}</span>
        <RecImprint label={track.label} year={track.year} />
        <span className="rec-row-chips">
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

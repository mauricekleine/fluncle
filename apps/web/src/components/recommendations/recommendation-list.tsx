// THE RECOMMENDATIONS LIST — the register split, canon-resolved (ROADMAP § the blend,
// option B). The ≤3 FINDINGS slots render first, in Fluncle's full voice: the Log ID leads
// (Oxanium, heats to gold — the Ignition Rule), the cover doubles as a preview play control
// (the saves-door singleton), the note is quoted as the row's WHY. They wear a quiet "from
// Fluncle's own log" label, never a badge-scream.
//
// Then the CATALOGUE rows in the INSTRUMENT register (DESIGN.md's Unlit Rule): cover, Artist
// — Title, no coordinate, no note, no invented noun. "Close to what you picked" is the
// section's ONE helper line — the machine's honest WHY, never per-row testimony.
//
// A recommendation you ENDORSE becomes a PICK: the row BODY is a pick control (the seed
// picker's grammar), so clicking a row seeds that track and refines the next round; a picked
// row shows the gold check and toggles off. Navigation moves to explicit SECONDARY targets,
// never nested inside the pick — a findings row keeps its Log ID linking to /log/<id>, a
// catalogue row keeps its Spotify glyph linking out (the track-row discipline: a stretched
// control with sibling links lifted above it). Both registers carry the instrument readout
// (The Readout Rule): the duration/BPM/key chips, and the release year where it exists.

import { CheckIcon, PauseIcon, PlayIcon, PlusIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SpotifyIcon } from "@/components/platform-icons";
import { TrackChips } from "@/components/track-row";
import { formatKey, type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { usePreviewPlayer } from "@/lib/preview-player";
import {
  type RecommendationCatalogueItem,
  type RecommendationFindingItem,
  type RecSeedItem,
  SEED_CAP,
} from "./shared";

export function RecommendationList({
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
  const hasAny = findings.length > 0 || catalogue.length > 0;
  const { notation } = useKeyNotation();
  const [pending, setPending] = useState<Set<string>>(new Set());

  const seededIds = useMemo(() => new Set(seeds.map((seed) => seed.trackId)), [seeds]);
  // At the cap an UN-picked row disables (the picker's cap discipline); a picked row always
  // stays toggle-removable, so the reader can trade one seed for another without a dead end.
  const atCap = seeds.length >= SEED_CAP;

  // The pick gesture, pending-guarded per track exactly as the picker's own rows are — a click
  // adds when un-picked, removes when picked (the toggle), and the door refetches both the
  // seed set and the recommendations after either write.
  async function pick(trackId: string, seeded: boolean) {
    setPending((current) => new Set(current).add(trackId));

    try {
      await (seeded ? onRemove(trackId) : onAdd(trackId));
    } finally {
      setPending((current) => {
        const next = new Set(current);

        next.delete(trackId);

        return next;
      });
    }
  }

  if (!hasAny) {
    return (
      <section className="account-section">
        <p className="account-muted">
          {seedsSkipped.length > 0
            ? "Fluncle hasn't got the audio for your picks yet, so there's nothing to line up against them. Give it a day, or point him at a few more."
            : "Nothing lined up yet. Add a few more picks and Fluncle goes digging."}
        </p>
      </section>
    );
  }

  return (
    <>
      {findings.length > 0 ? (
        <section className="account-section rec-findings">
          <p className="account-kicker rec-from-log">From Fluncle&rsquo;s own log</p>
          <ul className="account-list rec-finding-list">
            {findings.map((finding) => {
              const seeded = seededIds.has(finding.trackId);

              return (
                <FindingRow
                  busy={pending.has(finding.trackId)}
                  disabled={!seeded && atCap}
                  finding={finding}
                  key={finding.trackId}
                  notation={notation}
                  onPick={() => void pick(finding.trackId, seeded)}
                  seeded={seeded}
                />
              );
            })}
          </ul>
        </section>
      ) : null}

      {catalogue.length > 0 ? (
        <section className="account-section rec-catalogue">
          <h2>More to dig</h2>
          <p className="account-muted">Close to what you picked.</p>
          <ul className="account-list rec-catalogue-list">
            {catalogue.map((track) => {
              const seeded = seededIds.has(track.trackId);

              return (
                <CatalogueRow
                  busy={pending.has(track.trackId)}
                  disabled={!seeded && atCap}
                  key={track.trackId}
                  notation={notation}
                  onPick={() => void pick(track.trackId, seeded)}
                  seeded={seeded}
                  track={track}
                />
              );
            })}
          </ul>
        </section>
      ) : null}

      {seedsSkipped.length > 0 && findings.length + catalogue.length > 0 ? (
        <p className="account-muted rec-skipped">
          {seedsSkipped.length === 1
            ? "One of your picks isn't steering yet — Fluncle hasn't got its audio."
            : `${seedsSkipped.length} of your picks aren't steering yet — Fluncle hasn't got their audio.`}
        </p>
      ) : null}
    </>
  );
}

/** The pick state indicator — the gold check when picked, a quiet plus when not (the picker's
 *  own glyphs). Decorative: the real control is the stretched pick button that carries the
 *  aria-label, so this is `aria-hidden`. A row at the cap that is not picked shows nothing. */
function PickGlyph({ disabled, seeded }: { disabled: boolean; seeded: boolean }) {
  if (seeded) {
    return <CheckIcon aria-hidden className="rec-seeded-check" weight="bold" />;
  }

  if (disabled) {
    return null;
  }

  return <PlusIcon aria-hidden className="rec-add-glyph" weight="bold" />;
}

/** The instrument readout for a row — the shared chips plus the release year (The Readout
 *  Rule). Key formatting rides the reader's own notation, the finding-card idiom. Shared with
 *  the seed picker's candidate rows so every track-shaped row reads the same. */
export function TrackReadout({
  bpm,
  durationMs,
  musicalKey,
  notation,
  year,
}: {
  bpm?: number;
  durationMs?: number;
  musicalKey?: string;
  notation: KeyNotation;
  year?: string;
}) {
  const keyText = formatKey(musicalKey, notation);

  if (!durationMs && !bpm && !keyText && !year) {
    return null;
  }

  return (
    <span className="rec-readout">
      <TrackChips
        bpm={bpm}
        className="mt-0"
        durationMs={durationMs}
        musicalKey={keyText || undefined}
      />
      {year ? <span className="rec-year">{year}</span> : null}
    </span>
  );
}

/**
 * A recommended finding — the archive's ignition grammar (the saves-door row). The Log ID
 * leads and heats gold (a link to /log/<id>, the row's secondary target), the cover carries
 * the preview play control through the shared `/api/preview` singleton, and the note reads
 * beneath as the WHY. The row BODY is the pick: a stretched button that seeds this finding, so
 * endorsing it refines the next round. A certified row speaks; it earns the full voice.
 */
function FindingRow({
  busy,
  disabled,
  finding,
  notation,
  onPick,
  seeded,
}: {
  busy: boolean;
  disabled: boolean;
  finding: RecommendationFindingItem;
  notation: KeyNotation;
  onPick: () => void;
  seeded: boolean;
}) {
  const preview = usePreviewPlayer(finding.trackId);
  const trackLine = `${finding.artists.join(", ")} — ${finding.title}`;
  const cover = albumCoverAtSize(finding.imageUrl, "small");
  const pickLabel = seeded
    ? `Remove ${trackLine} from your picks`
    : `Add ${trackLine} to your picks`;

  return (
    <li className="rec-finding-row">
      <Link
        aria-label={`Open the log page for ${trackLine}`}
        className="track-log-id track-log-id-link rec-finding-logid"
        params={{ logId: finding.logId }}
        to="/log/$logId"
      >
        {finding.logId}
      </Link>

      <span className="preview-art rec-cover-wrap">
        {cover ? (
          <img alt="" className="rec-cover" height={40} loading="lazy" src={cover} width={40} />
        ) : (
          <span aria-hidden className="rec-cover rec-cover--empty" />
        )}
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

      <span className="rec-finding-body min-w-0">
        <button
          aria-label={pickLabel}
          aria-pressed={seeded}
          className="rec-finding-title block rec-pick-stretch"
          disabled={disabled || busy}
          onClick={onPick}
          type="button"
        >
          <span className="rec-finding-titletext">{trackLine}</span>
        </button>
        <TrackReadout
          bpm={finding.bpm}
          durationMs={finding.durationMs}
          musicalKey={finding.key}
          notation={notation}
          year={finding.year}
        />
        {finding.note ? <span className="rec-finding-note">{finding.note}</span> : null}
      </span>

      <span className="rec-finding-tail" aria-hidden>
        <PickGlyph disabled={disabled} seeded={seeded} />
      </span>
    </li>
  );
}

/**
 * A recommended catalogue track — the instrument register. Cover-led, cold (the Dust Veil),
 * no coordinate and no note. The row BODY is the pick (a stretched button that seeds the
 * track); the Spotify glyph stays as a SECONDARY link out, lifted above the pick so it stays
 * its own target — an uncertified track has no /log page to open. The similarity is NEVER
 * printed per row — it's the section's one helper line.
 */
function CatalogueRow({
  busy,
  disabled,
  notation,
  onPick,
  seeded,
  track,
}: {
  busy: boolean;
  disabled: boolean;
  notation: KeyNotation;
  onPick: () => void;
  seeded: boolean;
  track: RecommendationCatalogueItem;
}) {
  const trackLine = `${track.artists.join(", ")} — ${track.title}`;
  const cover = albumCoverAtSize(track.imageUrl, "small");
  const href = track.spotifyUrl ?? spotifyUrlFromUri(track.spotifyUri);
  const artistLine = track.year
    ? `${track.artists.join(", ")} · ${track.year}`
    : track.artists.join(", ");
  const pickLabel = seeded
    ? `Remove ${trackLine} from your picks`
    : `Add ${trackLine} to your picks`;

  return (
    <li className="rec-catalogue-row rec-catalogue-row--unlit">
      {cover ? (
        <img alt="" className="rec-cover" height={40} loading="lazy" src={cover} width={40} />
      ) : (
        <span aria-hidden className="rec-cover rec-cover--empty" />
      )}

      <button
        aria-label={pickLabel}
        aria-pressed={seeded}
        className="rec-catalogue-body rec-pick-stretch min-w-0"
        disabled={disabled || busy}
        onClick={onPick}
        type="button"
      >
        <span className="rec-catalogue-title">{track.title}</span>
        <span className="rec-catalogue-artists">{artistLine}</span>
        <TrackReadout
          bpm={track.bpm}
          durationMs={track.durationMs}
          musicalKey={track.key}
          notation={notation}
        />
      </button>

      <span className="rec-catalogue-tail">
        {href ? (
          <a
            aria-label={`Open ${trackLine} on Spotify`}
            className="rec-catalogue-out"
            href={href}
            rel="noopener noreferrer"
            target="_blank"
          >
            <SpotifyIcon className="rec-candidate-out" />
          </a>
        ) : null}
        <PickGlyph disabled={disabled} seeded={seeded} />
      </span>
    </li>
  );
}

/** Build a Spotify web URL from a `spotify:track:<id>` URI when the DTO carries no URL. */
function spotifyUrlFromUri(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }

  const match = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri);

  return match ? `https://open.spotify.com/track/${match[1]}` : undefined;
}

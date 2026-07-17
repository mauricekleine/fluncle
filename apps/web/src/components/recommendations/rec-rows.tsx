// THE SHARED ROW PIECES of the /recommendations builder — the bits both panels
// lean on: the instrument readout (The Readout Rule), the Stardust imprint line,
// the 40px cover with its eclipse fallback, the gold coordinate pill (the Fluncle
// seal, worn by a finding in its chips row), and the Add pill (the one "pull this
// track into your picks" gesture). Kept tiny and presentational; the panels own
// the behaviour.

import { CheckIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { TrackChips } from "@/components/track-row";
import { formatKey, type KeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";

/** The instrument readout for a row — the shared chips (The Readout Rule). Key formatting
 *  rides the reader's own notation (the finding-card idiom). Renders every chip the row can
 *  back and drops only what the data cannot. */
export function TrackReadout({
  bpm,
  durationMs,
  musicalKey,
  notation,
}: {
  bpm?: number;
  durationMs?: number;
  musicalKey?: string;
  notation: KeyNotation;
}) {
  const keyText = formatKey(musicalKey, notation);

  if (!durationMs && !bpm && !keyText) {
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
    </span>
  );
}

/**
 * The Stardust imprint line — the home Track Row's `Soulvent Records (2017)` anatomy, worn by
 * every rec row so a builder row reads like a log row. PLAIN TEXT, never a GraphLink: the
 * row's job is choosing, not navigating (the navigation lives on its own explicit targets).
 */
export function RecImprint({ label, year }: { label?: string; year?: string }) {
  if (!label && !year) {
    return null;
  }

  return (
    <span className="track-label rec-imprint block truncate">
      {label ?? ""}
      {label && year ? ` (${year})` : (year ?? "")}
    </span>
  );
}

/** The 40px cover with the eclipse-gradient fallback (the Track Row's artwork grammar). */
export function RecCover({ url }: { url?: string }) {
  const cover = albumCoverAtSize(url, "small");

  return cover ? (
    <img alt="" className="rec-cover" height={40} loading="lazy" src={cover} width={40} />
  ) : (
    <span aria-hidden className="rec-cover rec-cover--empty" />
  );
}

/**
 * THE FLUNCLE SEAL — the gold coordinate pill a certified finding wears in its chips row,
 * where the catalogue cuts have nothing. The register split rides the light, never the
 * layout: same row anatomy for every recommendation, and this one gold mark (a link to
 * /log/<id>) says whose ears vouched for it.
 */
export function RecSeal({ logId, trackLine }: { logId: string; trackLine: string }) {
  return (
    <Link
      aria-label={`Open the log page for ${trackLine}`}
      className="rec-seal"
      params={{ logId }}
      to="/log/$logId"
    >
      {logId}
    </Link>
  );
}

/**
 * THE ADD PILL — the one "into your picks" gesture on the page (Spotify's own Recommended
 * grammar: the row carries the music, the pill carries the action). Unpicked it reads "Add"
 * and heats on hover; picked it flips to the gold check and "Added" and lies still (a
 * recommended row vanishes on the refetch anyway — the picked pill is the confirmation beat
 * in between). At the cap an un-picked pill disables; a picked one never locks (the door
 * removes, never strands).
 */
export function AddPill({
  busy,
  disabled,
  label,
  onPick,
  picked,
}: {
  busy: boolean;
  disabled: boolean;
  label: string;
  onPick: () => void;
  picked: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={picked}
      className="rec-add-pill"
      disabled={busy || (disabled && !picked)}
      onClick={onPick}
      type="button"
    >
      {picked ? (
        <>
          <CheckIcon aria-hidden="true" className="rec-add-pill-check" weight="bold" />
          Added
        </>
      ) : (
        "Add"
      )}
    </button>
  );
}

/** The playlist position, two digits, always tabular (The Tabular Rule). */
export function padIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

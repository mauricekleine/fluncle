import { CheckIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { TrackChips } from "@/components/track-row";
import { formatKey, type KeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";

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

export function RecCover({ url }: { url?: string }) {
  const cover = albumCoverAtSize(url, "small");

  return cover ? (
    <img alt="" className="rec-cover" height={40} loading="lazy" src={cover} width={40} />
  ) : (
    <span aria-hidden className="rec-cover rec-cover--empty" />
  );
}

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

export function padIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

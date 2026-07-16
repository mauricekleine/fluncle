// THE RECOMMENDATIONS LIST — the register split, canon-resolved (ROADMAP § the blend,
// option B). The ≤3 FINDINGS slots render first, in Fluncle's full voice: the Log ID leads
// (Oxanium, heats to gold — the Ignition Rule), the cover doubles as a preview play control
// (the saves-door singleton), the note is quoted as the row's WHY, and the whole row opens
// /log/<id>. They wear a quiet "from Fluncle's own log" label, never a badge-scream.
//
// Then the CATALOGUE rows in the INSTRUMENT register (DESIGN.md's Unlit Rule): cover, Artist
// — Title, no coordinate, no note, no invented noun. "Close to what you picked" is the
// section's ONE helper line — the machine's honest WHY, never per-row testimony. Each links
// OUT to Spotify, because an uncertified track has no /log page to open.

import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { SpotifyIcon } from "@/components/platform-icons";
import { albumCoverAtSize } from "@/lib/media";
import { usePreviewPlayer } from "@/lib/preview-player";
import { type RecommendationCatalogueItem, type RecommendationFindingItem } from "./shared";

export function RecommendationList({
  catalogue,
  findings,
  seedsSkipped,
}: {
  catalogue: RecommendationCatalogueItem[];
  findings: RecommendationFindingItem[];
  seedsSkipped: string[];
}) {
  const hasAny = findings.length > 0 || catalogue.length > 0;

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
            {findings.map((finding) => (
              <FindingRow finding={finding} key={finding.trackId} />
            ))}
          </ul>
        </section>
      ) : null}

      {catalogue.length > 0 ? (
        <section className="account-section rec-catalogue">
          <h2>More to dig</h2>
          <p className="account-muted">Close to what you picked.</p>
          <ul className="account-list rec-catalogue-list">
            {catalogue.map((track) => (
              <CatalogueRow key={track.trackId} track={track} />
            ))}
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

/**
 * A recommended finding — the archive's ignition grammar (the saves-door row). The Log ID
 * leads and heats gold, the cover carries the preview play control through the shared
 * `/api/preview` singleton (starting one row stops any other), the row opens /log/<id>, and
 * the note reads beneath as the WHY. A certified row speaks; it earns the full voice.
 */
function FindingRow({ finding }: { finding: RecommendationFindingItem }) {
  const preview = usePreviewPlayer(finding.trackId);
  const trackLine = `${finding.artists.join(", ")} — ${finding.title}`;
  const cover = albumCoverAtSize(finding.imageUrl, "small");

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
        <Link
          aria-label={`Open the log page for ${trackLine}`}
          className="track-row-link"
          params={{ logId: finding.logId }}
          to="/log/$logId"
        >
          <span className="rec-finding-title block">{trackLine}</span>
        </Link>
        {finding.note ? <span className="rec-finding-note">{finding.note}</span> : null}
      </span>
    </li>
  );
}

/**
 * A recommended catalogue track — the instrument register. Cover-led, cold (the Dust Veil),
 * no coordinate and no note, and it links OUT to Spotify because there is no /log page for a
 * track Fluncle has not certified. The similarity is NEVER printed per row — it's the
 * section's one helper line. A track with no Spotify anchor renders as a bare, quiet row.
 */
function CatalogueRow({ track }: { track: RecommendationCatalogueItem }) {
  const trackLine = `${track.artists.join(", ")} — ${track.title}`;
  const cover = albumCoverAtSize(track.imageUrl, "small");
  const href = track.spotifyUrl ?? spotifyUrlFromUri(track.spotifyUri);

  const inner = (
    <>
      {cover ? (
        <img alt="" className="rec-cover" height={40} loading="lazy" src={cover} width={40} />
      ) : (
        <span aria-hidden className="rec-cover rec-cover--empty" />
      )}
      <span className="rec-catalogue-body min-w-0">
        <span className="rec-catalogue-title">{track.title}</span>
        <span className="rec-catalogue-artists">{track.artists.join(", ")}</span>
      </span>
      {href ? <SpotifyIcon className="rec-candidate-out" /> : null}
    </>
  );

  if (!href) {
    return <li className="rec-catalogue-row rec-catalogue-row--unlit">{inner}</li>;
  }

  return (
    <li className="rec-catalogue-row rec-catalogue-row--unlit">
      <a
        aria-label={`Open ${trackLine} on Spotify`}
        className="rec-catalogue-link"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {inner}
      </a>
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

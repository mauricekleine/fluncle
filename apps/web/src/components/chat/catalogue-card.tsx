import { SpotifyIcon } from "@/components/platform-icons";

// THE CATALOGUE LIST — the unlit register in ChatDnB (the register split, Unit C).
//
// A finding is lit: it carries its Log ID coordinate, its cover, a play control, and Fluncle
// speaks about it in full. A catalogue row is a track Fluncle knows is out there but has never
// certified — so it catches the Dust Veil instead (DESIGN.md, the Unlit Rule): no gold, no cover,
// no coordinate, no play, and it links OUT to Spotify because there is no /log page to go to. The
// tier is never named — no badge, no noun of its own; the register IS the statement. This mirrors
// the web's ratified unlit carrier (search-command.tsx) and the /mix builder's unlit rows.
//
// The type is DISTINCT from a finding on purpose. A `ChatCatalogueTrack` carries only a name, its
// artists, and a way out — it can never hold a coordinate, a note, a BPM, or a cover, so a
// catalogue row cannot render as a degraded finding, and `collectChatFindings` never sweeps one
// (it keys off `finding`/`findings`/`set`, never a `catalogue` bucket). The mirror of the server's
// `CatalogueTrackItem`.

/**
 * A catalogue row as the chat tools emit it — a name and its artists, plus a best-effort way out
 * and quiet context. NOTHING that would make Fluncle speak about it as a finding: no coordinate,
 * note, observation, cover, galaxy, BPM, key, or preview. The distinct type is the compile-time
 * guarantee that a catalogue row can never carry lit data.
 */
export type ChatCatalogueTrack = {
  artists: string[];
  /** The label the row sits on, when known — context, never a per-track lit claim. */
  label?: string;
  /** The record it came off, when known — context, never a per-track lit claim. */
  release?: string;
  /** When it came OUT (a release date), present only on the fresh list. A public RELEASE fact, NOT
      a Fluncle measurement like the bpm/key/cover an unlit row never carries — so it is register-safe
      here. The row does not print it; it rides the tool output so Fluncle can cite when it dropped. */
  releaseDate?: string;
  /** The way out. A catalogue row has no /log page, so Spotify is where it goes (when it has one). */
  spotifyUrl?: string;
  title: string;
};

// A chat turn should not spill a wall of rows; the list shows at most this many and names the
// rest as a quiet count, the same restraint the Finding List keeps.
const MAX_ROWS = 8;

/**
 * A quiet, ruled list of catalogue rows — the unlit block. `heading` is set by the caller ONLY
 * when findings render above it (then "Tracks" names the true superset, the mix-builder / search
 * precedent); a catalogue-only answer passes none and the block stands bare, because a heading
 * over the only content would exist just to name the tier (the Unlit Rule).
 */
export function CatalogueList({
  catalogue,
  heading,
}: {
  catalogue: ChatCatalogueTrack[];
  heading?: string;
}) {
  const shown = catalogue.slice(0, MAX_ROWS);
  const remaining = catalogue.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      {heading ? <p className="px-1 text-xs text-muted-foreground">{heading}</p> : null}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card px-3">
        {shown.map((track, index) => (
          <CatalogueRow key={track.spotifyUrl ?? `${track.title}-${index}`} track={track} />
        ))}
      </ul>
      {remaining > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">+{remaining} more</p>
      ) : null}
    </div>
  );
}

// One catalogue row. Dimmed to Stardust (the Dust Veil), no artwork, no coordinate — just the
// `Artist — Title` line, its quiet context, and the Spotify mark where the row can actually be
// heard. The Spotify mark comes from `simple-icons` via platform-icons (DESIGN.md Iconography),
// never a Phosphor glyph for a brand.
function CatalogueRow({ track }: { track: ChatCatalogueTrack }) {
  const artists = track.artists ?? [];
  const trackLine = artists.length > 0 ? `${artists.join(", ")} — ${track.title}` : track.title;
  const context = [track.release, track.label].filter(Boolean).join(" · ");

  return (
    <li className="flex items-center gap-2.5 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-muted-foreground">{trackLine}</p>
        {context ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{context}</p>
        ) : null}
      </div>
      {track.spotifyUrl ? (
        <a
          aria-label={`Open ${track.title} on Spotify`}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          href={track.spotifyUrl}
          rel="noreferrer"
          target="_blank"
        >
          <SpotifyIcon aria-hidden="true" className="size-4" />
        </a>
      ) : null}
    </li>
  );
}

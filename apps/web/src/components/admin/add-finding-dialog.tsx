import { CheckCircleIcon, CircleNotchIcon, PlusIcon } from "@phosphor-icons/react";
import { type PublishTrackResult, type TrackListItem } from "@fluncle/contracts";
import { type FormEvent, useCallback, useId, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Textarea } from "@fluncle/ui/components/textarea";
import { FindingIdentity } from "@/components/admin/finding-identity";
import { spotifyTrackIdOf } from "@/lib/spotify-track-id";

// The board's [Add finding] dialog — the web intake for the operator's own add
// path. Paste a Spotify track link, optionally a note, and publish: the SAME
// `publish_track` op the CLI's `fluncle add` posts to (`POST /api/admin/tracks`,
// operator tier via the grant cookie), so certification is identical — playlist
// + Telegram + the minted Log ID — and the async crons enrich behind it.
//
// The link is validated client-side with the shared grammar (lib/spotify-track-id,
// the same module the server's parser delegates to), so a bad paste never
// round-trips. A 409 duplicate is NOT an error here: the server's dedupe answer
// becomes data — the existing finding, fetched via `get_track_admin`, rendered on
// the gold confirmation veil with its coordinate link.

type AddPhase =
  /** The paste form (also the busy state while the publish runs). */
  | { kind: "form" }
  /** Published: the fresh finding with its minted coordinate. */
  | { kind: "logged"; result: PublishTrackResult }
  /** The server deduped: the finding already in the archive, shown as data. */
  | { kind: "found"; incomplete: boolean; track?: TrackListItem };

type AddFindingDialogProps = {
  /** Fired after a successful publish, so the board refetches. */
  onAdded: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export function AddFindingDialog({ onAdded, onOpenChange, open }: AddFindingDialogProps) {
  const linkId = useId();
  const linkErrorId = useId();
  const noteId = useId();
  const [link, setLink] = useState("");
  const [note, setNote] = useState("");
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [phase, setPhase] = useState<AddPhase>({ kind: "form" });

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (busy) {
        return;
      }

      if (!next) {
        // Reset so the next open starts on a clean form.
        setLink("");
        setNote("");
        setLinkInvalid(false);
        setError(undefined);
        setPhase({ kind: "form" });
      }

      onOpenChange(next);
    },
    [busy, onOpenChange],
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const trackId = spotifyTrackIdOf(link);

      if (!trackId) {
        setLinkInvalid(true);
        return;
      }

      setBusy(true);
      setError(undefined);

      try {
        const response = await fetch("/api/v1/admin/tracks", {
          body: JSON.stringify({
            note: note.trim() || undefined,
            spotifyUrl: link.trim(),
          }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = (await response.json()) as Partial<PublishTrackResult> & {
          code?: string;
          message?: string;
          ok?: boolean;
        };

        if (response.ok && data.ok && data.track) {
          setPhase({ kind: "logged", result: data as PublishTrackResult });
          onAdded();
          return;
        }

        // The server's dedupe: the finding is already in the archive. Data, not a
        // failure — fetch the existing row so the panel can name it and link its
        // coordinate. A failed lookup still renders the found panel, just barer.
        if (
          response.status === 409 &&
          (data.code === "duplicate" || data.code === "incomplete_duplicate")
        ) {
          setPhase({
            incomplete: data.code === "incomplete_duplicate",
            kind: "found",
            track: await fetchExistingTrack(trackId),
          });
          return;
        }

        throw new Error(data.message ?? `Add failed (${response.status})`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [link, note, onAdded],
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusIcon aria-hidden="true" className="size-4" weight="bold" />
            Add a finding
          </DialogTitle>
          <DialogDescription>
            Paste a Spotify track link. Adding certifies it: the playlist, the Telegram post, its
            permanent Log ID. The box crons enrich it behind you.
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "logged" ? (
          <LoggedPanel onDone={() => handleOpenChange(false)} result={phase.result} />
        ) : phase.kind === "found" ? (
          <FoundPanel
            incomplete={phase.incomplete}
            onDone={() => handleOpenChange(false)}
            track={phase.track}
          />
        ) : (
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <div className="space-y-1.5">
              <Label htmlFor={linkId}>Spotify link</Label>
              <Input
                aria-describedby={linkInvalid ? linkErrorId : undefined}
                aria-invalid={linkInvalid || undefined}
                autoComplete="off"
                autoFocus
                id={linkId}
                inputMode="url"
                onBlur={() => setLinkInvalid(link.trim() !== "" && !spotifyTrackIdOf(link))}
                onChange={(event) => {
                  setLink(event.target.value);

                  // A paste that parses clears the hint immediately; a bad one
                  // waits for blur/submit so typing isn't flagged mid-keystroke.
                  if (spotifyTrackIdOf(event.target.value)) {
                    setLinkInvalid(false);
                  }
                }}
                placeholder="https://open.spotify.com/track/…"
                spellCheck={false}
                value={link}
              />
              {linkInvalid ? (
                <p className="text-sm text-destructive" id={linkErrorId}>
                  That isn’t a Spotify track link.
                </p>
              ) : undefined}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={noteId}>
                Note <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id={noteId}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Why this one. Rides the Telegram post and the log page."
                rows={2}
                value={note}
              />
            </div>

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : undefined}

            <Button className="w-full" disabled={busy} type="submit">
              {busy ? (
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
              ) : (
                <PlusIcon aria-hidden="true" weight="bold" />
              )}
              {busy ? "Logging…" : "Add finding"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The fresh finding: the certified line, its minted coordinate, and the honest
// "the rest fills in" note (enrichment is async — the board's cells catch up as
// the crons write back).
function LoggedPanel({ onDone, result }: { onDone: () => void; result: PublishTrackResult }) {
  const { track } = result;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/10 p-3">
        <p className="flex items-center gap-2 text-sm font-bold">
          <CheckCircleIcon aria-hidden="true" className="size-4 text-primary" weight="fill" />
          Banger logged
        </p>
        <TrackLine
          albumImageUrl={track.albumImageUrl}
          artists={track.artists}
          logId={track.logId}
          title={track.title}
        />
        <p className="text-xs text-muted-foreground">
          Added to Spotify · Posted to Telegram. Enrichment fills in as the box crons run.
        </p>
      </div>

      {/* autoFocus: the submit button the operator just pressed unmounted with
          the form — land keyboard focus on the panel's one action. */}
      <Button autoFocus className="w-full" onClick={onDone} variant="outline">
        Done
      </Button>
    </div>
  );
}

// The dedupe answer as data: the finding is already in the archive, so name it
// and hand over its coordinate. An incomplete earlier attempt states the two
// certification facts plainly (the repair is a separate act).
function FoundPanel({
  incomplete,
  onDone,
  track,
}: {
  incomplete: boolean;
  onDone: () => void;
  track?: TrackListItem;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/10 p-3">
        <p className="text-sm font-bold">Already found</p>
        {track ? (
          <TrackLine
            albumImageUrl={track.albumImageUrl}
            artists={track.artists}
            logId={track.logId}
            title={track.title}
          />
        ) : undefined}
        {incomplete && track ? (
          <p className="text-xs text-muted-foreground">
            {track.addedToSpotify ? "Added to Spotify" : "Not added to Spotify"} ·{" "}
            {track.postedToTelegram ? "Posted to Telegram" : "Not posted to Telegram"}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {incomplete
              ? "An earlier add didn’t finish; its row is on the board."
              : "This one is already in the archive."}
          </p>
        )}
      </div>

      {/* autoFocus: same focus hand-off as the logged panel. */}
      <Button autoFocus className="w-full" onClick={onDone} variant="outline">
        Done
      </Button>
    </div>
  );
}

// One finding line: artwork, the artists — title, and the coordinate deep-link when a
// Log ID exists (the shared FindingIdentity's inline/art form — the same block the plan
// builder and the board render, bound to this dialog's plain track fields).
function TrackLine({
  albumImageUrl,
  artists,
  logId,
  title,
}: {
  albumImageUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
}) {
  return (
    <FindingIdentity
      artists={artists}
      cover={albumImageUrl}
      coverVariant="art"
      logId={logId}
      logIdHref={logId ? `/log/${encodeURIComponent(logId)}` : undefined}
      size="sm"
      title={title}
      titleFormat="inline"
    />
  );
}

// The existing row behind a 409 — `get_track_admin` by the parsed trackId (the
// paste itself names the coordinate to look up). Best-effort: the found panel
// renders without it.
async function fetchExistingTrack(trackId: string): Promise<TrackListItem | undefined> {
  try {
    const response = await fetch(`/api/v1/admin/tracks/${encodeURIComponent(trackId)}`, {
      credentials: "same-origin",
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { ok?: boolean; track?: TrackListItem };

    return data.ok ? data.track : undefined;
  } catch {
    return undefined;
  }
}

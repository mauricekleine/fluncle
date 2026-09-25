import { DotsThreeIcon, PauseIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@fluncle/ui/components/alert-dialog";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { Input } from "@fluncle/ui/components/input";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { TrackArtwork } from "@/components/track-artwork";
import { formatDateLong } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { toQueueTrack } from "@/lib/player-tracks";
import { usePreviewPlayer } from "@/lib/preview-player";
import { unsaveTrack } from "@/lib/saved-tracks";
import {
  filterSavedFindings,
  SAVES_POWER_SCALE,
  type SavesSort,
  sortSavedFindings,
} from "./saves-filter";
import {
  ListEmpty,
  type SavedFinding,
  type Follow,
  type FollowsEmail,
  type SavedSet,
  type SavesDoorData,
  type Submission,
} from "./shared";

export function SavesDoor({
  csrfToken,
  data,
  refresh,
}: {
  csrfToken: string;
  data: SavesDoorData;
  refresh: () => Promise<void>;
}) {
  const [setsMessage, setSetsMessage] = useState("");
  const { follows, followsEmail, saved, sets, submissions } = data;

  return (
    <div className="account-tab-panel">
      <p className="account-kicker">Saves</p>

      <SavedFindingsSection
        csrfToken={csrfToken}
        findings={saved}
        refresh={refresh}
        setMessage={setSetsMessage}
      />

      <section className="account-section">
        <h2>Saved sets</h2>
        <ListEmpty items={sets} empty="No saved sets yet. Chain one on /mix and save it here.">
          {sets.map((set) => (
            <SavedSetRow
              csrfToken={csrfToken}
              key={set.id}
              refresh={refresh}
              set={set}
              setMessage={setSetsMessage}
            />
          ))}
        </ListEmpty>
        {setsMessage ? (
          <p aria-live="polite" className="account-muted">
            {setsMessage}
          </p>
        ) : null}
      </section>

      <FollowingSection
        csrfToken={csrfToken}
        follows={follows}
        followsEmail={followsEmail}
        refresh={refresh}
      />

      <SentLedger submissions={submissions} />
    </div>
  );
}

function SavedFindingsSection({
  csrfToken,
  findings,
  refresh,
  setMessage,
}: {
  csrfToken: string;
  findings: SavedFinding[];
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SavesSort>("saved");
  const showTools = findings.length > SAVES_POWER_SCALE;

  const visible = useMemo(
    () => sortSavedFindings(filterSavedFindings(findings, query), sort),
    [findings, query, sort],
  );

  return (
    <section className="account-section">
      <h2>Saved tracks</h2>

      {showTools ? (
        <div className="saves-tools">
          <Input
            aria-label="Search saved tracks by artist or title"
            className="saves-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by artist or title"
            type="search"
            value={query}
          />

          <Button
            onClick={() => setSort(sort === "saved" ? "title" : "saved")}
            size="sm"
            type="button"
            variant="outline"
          >
            {sort === "saved" ? "Sort by title" : "Sort by newest"}
          </Button>
        </div>
      ) : null}

      {findings.length === 0 ? (
        <p className="account-muted">
          Nothing saved yet. When a track grabs you, tap Save and it lands here.
        </p>
      ) : visible.length === 0 ? (
        <p aria-live="polite" className="account-muted">
          No saved tracks match that search.
        </p>
      ) : (
        <ul className="account-list saves-list">
          {visible.map((finding) => (
            <SavedFindingRow
              csrfToken={csrfToken}
              finding={finding}
              key={finding.trackId}
              refresh={refresh}
              setMessage={setMessage}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function SavesDoorSkeleton() {
  return (
    <div className="account-tab-panel" aria-hidden>
      <Skeleton className="h-4 w-16" />
      <section className="account-section">
        <Skeleton className="h-4 w-32" />
        {[0, 1, 2].map((row) => (
          <div className="saves-row" key={row}>
            <Skeleton className="h-4 w-14" />
            <Skeleton className="saves-cover" />
            <div className="saves-row-body flex-1">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function SavedFindingRow({
  csrfToken,
  finding,
  refresh,
  setMessage,
}: {
  csrfToken: string;
  finding: SavedFinding;
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const trackLine = `${finding.artists.join(", ")} — ${finding.title}`;

  async function remove() {
    setBusy(true);

    try {
      const response = await fetch(`/api/v1/me/saved-findings/${finding.trackId}`, {
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "DELETE",
      });

      if (response.ok) {
        unsaveTrack(finding.trackId);
      }

      setMessage(response.ok ? "" : "Could not remove that save. Try again in a moment.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!finding.logId) {
    return (
      <li className="saves-row saves-row--unlit">
        <span aria-hidden className="saves-row-logid" />

        <span className="saves-cover-wrap">
          <TrackArtwork className="saves-cover" src={albumCoverAtSize(finding.imageUrl, "small")} />
        </span>

        <span className="saves-row-body min-w-0">
          {finding.href ? (
            <Link
              aria-label={`Open the track page for ${trackLine}`}
              className="track-row-link"
              to={finding.href as never}
            >
              <span className="saves-row-title block">{trackLine}</span>
            </Link>
          ) : (
            <span className="saves-row-title block">{trackLine}</span>
          )}
          <span className="saves-row-meta">Saved {formatDateLong(finding.savedAt)}</span>
        </span>

        <SavedFindingMenu busy={busy} finding={finding} onRemove={() => void remove()} />
      </li>
    );
  }

  return (
    <SavedFindingLitRow
      busy={busy}
      finding={finding}
      logId={finding.logId}
      onRemove={remove}
      trackLine={trackLine}
    />
  );
}

function SavedFindingLitRow({
  busy,
  finding,
  logId,
  onRemove,
  trackLine,
}: {
  busy: boolean;
  finding: SavedFinding;
  logId: string;
  onRemove: () => Promise<void>;
  trackLine: string;
}) {
  const queued = useMemo(
    () => toQueueTrack({ ...finding, albumImageUrl: finding.imageUrl }),
    [finding],
  );
  const preview = usePreviewPlayer(finding.trackId, { publicPreview: true, track: queued });

  return (
    <li className="saves-row">
      <Link
        aria-label={`Open the log page for ${trackLine}`}
        className="track-log-id track-log-id-link saves-row-logid"
        params={{ logId }}
        to="/log/$logId"
      >
        {logId}
      </Link>

      <span className="preview-art saves-cover-wrap">
        <TrackArtwork className="saves-cover" src={albumCoverAtSize(finding.imageUrl, "small")} />
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

      <span className="saves-row-body min-w-0">
        <Link
          aria-label={`Open the log page for ${trackLine}`}
          className="track-row-link"
          params={{ logId }}
          to="/log/$logId"
        >
          <span className="saves-row-title block">{trackLine}</span>
        </Link>
        <span className="saves-row-meta">Saved {formatDateLong(finding.savedAt)}</span>
      </span>

      <SavedFindingMenu busy={busy} finding={finding} onRemove={() => void onRemove()} />
    </li>
  );
}

function SavedFindingMenu({
  busy,
  finding,
  onRemove,
}: {
  busy: boolean;
  finding: SavedFinding;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${finding.title}`}
        className="track-action saves-row-menu"
        disabled={busy}
      >
        <DotsThreeIcon aria-hidden="true" size={18} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {finding.note ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="saves-note">{finding.note}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={onRemove}>
          <TrashIcon aria-hidden="true" className="size-4" />
          Remove from saves
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SavedSetRow({
  csrfToken,
  refresh,
  set,
  setMessage,
}: {
  csrfToken: string;
  refresh: () => Promise<void>;
  set: SavedSet;
  setMessage: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(set.name);

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch(`/api/v1/me/saved-sets/${set.id}`, {
      body: JSON.stringify({ name }),
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "PATCH",
    });

    setEditing(false);
    setMessage(response.ok ? "Set renamed." : "Could not rename that set.");
    await refresh();
  }

  async function remove() {
    const response = await fetch(`/api/v1/me/saved-sets/${set.id}`, {
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "DELETE",
    });

    setMessage(response.ok ? "Set removed." : "Could not remove that set.");
    await refresh();
  }

  if (editing) {
    return (
      <li>
        <form className="account-row" onSubmit={(event) => void rename(event)}>
          <Input
            aria-label="Set name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <Button size="sm" type="submit" variant="outline">
            Save
          </Button>
          <Button
            onClick={() => {
              setName(set.name);
              setEditing(false);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className="account-set-row">
      <Link
        search={{
          from: set.id,
          fromName: set.name,
          set: set.setTokens,
          taste: set.taste ?? "",
          view: "build" as const,
        }}
        to="/mix"
      >
        {set.name}
      </Link>
      <span className="account-set-actions">
        <Button onClick={() => setEditing(true)} size="sm" type="button" variant="ghost">
          Rename
        </Button>
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button size="sm" type="button" variant="ghost">
                Delete
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this set?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes “{set.name}” from your saved sets. The tracks stay in the archive.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                Delete set
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </span>
    </li>
  );
}

function FollowingSection({
  csrfToken,
  follows,
  followsEmail,
  refresh,
}: {
  csrfToken: string;
  follows: Follow[];
  followsEmail: FollowsEmail;
  refresh: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [subscribed, setSubscribed] = useState(followsEmail.subscribed);
  const [busy, setBusy] = useState(false);

  async function toggleEmail() {
    if (busy) {
      return;
    }

    setBusy(true);

    const response = await fetch(
      `/api/v1/follow-digest/${subscribed ? "unsubscribe" : "subscribe"}?token=${encodeURIComponent(followsEmail.token)}`,
      { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST" },
    ).catch(() => undefined);

    if (response?.ok) {
      setSubscribed(!subscribed);
      setMessage(subscribed ? "Follows email off." : "Follows email on.");
    } else {
      setMessage("I couldn't change that just now. Try again in a moment.");
    }

    setBusy(false);
  }

  return (
    <section className="account-section">
      <h2>Following</h2>
      <ListEmpty
        items={follows}
        empty={
          subscribed
            ? "Not following anyone yet. Tap Follow on an artist or label and I'll send you their new tunes on Fridays. Odds are you'll hit rewind before I do."
            : "Not following anyone. Tap Follow on an artist or label and they show up here."
        }
      >
        {follows.map((follow) => (
          <FollowRow
            csrfToken={csrfToken}
            follow={follow}
            key={follow.id}
            refresh={refresh}
            setMessage={setMessage}
          />
        ))}
      </ListEmpty>
      {follows.length > 0 || !subscribed ? (
        <div className="account-row">
          <p className="account-muted">
            {subscribed
              ? "I send you new tunes from the artists and labels you follow on Fridays, and skip the weeks they're quiet."
              : "Your follows email is off. Start it and I'll send you new tunes from the artists and labels you follow on Fridays. First rewind's probably yours."}
          </p>
          <Button
            aria-disabled={busy}
            onClick={() => void toggleEmail()}
            size="sm"
            type="button"
            variant="outline"
          >
            {subscribed ? "Stop the follows email" : "Start the follows email"}
          </Button>
        </div>
      ) : null}
      <p aria-live="polite" className="account-muted">
        {message}
      </p>
    </section>
  );
}

function FollowRow({
  csrfToken,
  follow,
  refresh,
  setMessage,
}: {
  csrfToken: string;
  follow: Follow;
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  async function unfollow() {
    const response = await fetch(`/api/v1/me/follows/${follow.id}`, {
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "DELETE",
    });

    setMessage(
      response.ok ? "" : `I couldn't unfollow ${follow.name} just now. Try again in a moment.`,
    );
    await refresh();
  }

  return (
    <li className="account-set-row">
      {follow.kind === "artist" ? (
        <Link params={{ slug: follow.slug }} to="/artist/$slug">
          {follow.name}
        </Link>
      ) : (
        <Link params={{ slug: follow.slug }} to="/label/$slug">
          {follow.name}
        </Link>
      )}
      <span className="account-set-actions">
        <span className="account-muted text-xs">
          {follow.kind === "artist" ? "Artist" : "Label"}
        </span>
        <Button
          aria-label={`Unfollow ${follow.name}`}
          onClick={() => void unfollow()}
          size="sm"
          type="button"
          variant="ghost"
        >
          Unfollow
        </Button>
      </span>
    </li>
  );
}

const SENT_STATUS = {
  logged: { label: "Logged", variant: "default" },
  passed_on: { label: "Passed on", variant: "secondary" },
  pending_review: { label: "Pending", variant: "outline" },
} satisfies Record<string, { label: string; variant: "default" | "outline" | "secondary" }>;

function SentLedger({ submissions }: { submissions: Submission[] }) {
  return (
    <section className="account-section saves-sent">
      <h2>Sent to Fluncle</h2>
      {submissions.length === 0 ? (
        <p className="account-muted">
          Heard something Fluncle should log? Use Submit a track to send it his way.
        </p>
      ) : (
        <ul className="account-list saves-sent-list">
          {submissions.map((submission) => (
            <SentRow key={submission.id} submission={submission} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SentRow({ submission }: { submission: Submission }) {
  const trackLine = `${submission.artists.join(", ")} — ${submission.title}`;
  const status =
    SENT_STATUS[submission.status as keyof typeof SENT_STATUS] ?? SENT_STATUS.pending_review;

  return (
    <li className="saves-sent-row">
      {submission.logId ? (
        <Link
          aria-label={`Open the log page for ${trackLine}`}
          className="saves-sent-title"
          params={{ logId: submission.logId }}
          to="/log/$logId"
        >
          {trackLine}
        </Link>
      ) : (
        <span className="saves-sent-title">{trackLine}</span>
      )}
      <Badge variant={status.variant}>{status.label}</Badge>
    </li>
  );
}

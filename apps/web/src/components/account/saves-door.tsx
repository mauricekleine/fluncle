// The Saves door as the workbench (docs/planning/account-redesign-brief.md, Phase B3).
// A saved finding IS a certified finding, so its row adopts the archive's ignition
// grammar: the Log ID leads in Oxanium and heats to gold on hover/focus, the row washes
// the Gold Veil, the cover scales, and the whole row opens `/log/<id>`. The cover doubles
// as an inline play control (ruling #4) through the shared `/api/preview` singleton —
// one thing plays at a time, everywhere. The rare controls recede: Remove and the saved
// note sit behind a ⋮ menu (the Quiet Surface Rule), and search + sort appear only at
// power scale. Submissions leave the keep-lists for their own "Sent to Fluncle" ledger.

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
import { formatDateLong } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { usePreviewPlayer } from "@/lib/preview-player";
import {
  filterSavedFindings,
  SAVES_POWER_SCALE,
  type SavesSort,
  sortSavedFindings,
} from "./saves-filter";
import {
  ListEmpty,
  type SavedFinding,
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
  const { saved, sets, submissions } = data;

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

      <SentLedger submissions={submissions} />
    </div>
  );
}

/**
 * The saved findings — the workbench proper. The list carries the archive's row
 * grammar; above it, at power scale only, a quiet search + sort. The empty-list line
 * teaches the save gesture; a search that matches nothing says so without blaming the
 * user's spelling.
 */
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
      <h2>Saved findings</h2>

      {showTools ? (
        <div className="saves-tools">
          <Input
            aria-label="Search saved findings by artist or title"
            className="saves-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by artist or title"
            type="search"
            value={query}
          />
          {/* The toggle names the ACTION it performs (the Chrome Rule), not the state
              it left behind — pressing it re-sorts, and the label says to what. */}
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
          Nothing saved yet. Tap the bookmark on any finding in the archive and it lands here.
        </p>
      ) : visible.length === 0 ? (
        <p aria-live="polite" className="account-muted">
          No saved findings match that search.
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

/** The cover-row pending state, shown only on a client-side switch into Saves. */
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

/**
 * A saved finding, rendered the way every finding renders (the ignition grammar of
 * `.track-row`): the Log ID leads and heats to gold, the row washes the Gold Veil, the
 * cover scales — and the whole row is one link to `/log/<id>`. The cover carries the
 * inline play control (the `.preview-art` scrim + glyph), previewing through the shared
 * `/api/preview` singleton so starting one row stops any other. Remove and the saved
 * note recede behind the ⋮ menu; removing a save destroys nothing in the archive, so it
 * stays a plain action (no confirm).
 */
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
  // Key the preview off the trackId (the row's own identity, and what `/api/preview`
  // resolves). One shared <audio> element backs every row, so `toggle` starts this
  // finding and stops whatever was playing.
  const preview = usePreviewPlayer(finding.trackId);
  const trackLine = `${finding.artists.join(", ")} — ${finding.title}`;

  async function remove() {
    setBusy(true);

    try {
      // `requireJsonMutation` 415s ANY mutation without a JSON content-type — DELETEs
      // included (browser-verified; the monolith's remove shipped without it and never
      // worked). The saved-set mutations already carry it; this matches them.
      const response = await fetch(`/api/me/saved-findings/${finding.trackId}`, {
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "DELETE",
      });

      setMessage(response.ok ? "" : "Could not remove that save. Try again in a moment.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="saves-row">
      <Link
        aria-label={`Open the log page for ${trackLine}`}
        className="track-log-id track-log-id-link saves-row-logid"
        params={{ logId: finding.logId }}
        to="/log/$logId"
      >
        {finding.logId}
      </Link>

      <span className="preview-art saves-cover-wrap">
        {finding.imageUrl ? (
          <img
            alt=""
            className="saves-cover"
            height={40}
            loading="lazy"
            src={albumCoverAtSize(finding.imageUrl, "small")}
            width={40}
          />
        ) : (
          <span aria-hidden className="saves-cover" />
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

      <span className="saves-row-body min-w-0">
        {/* The stretched row link mirrors TrackRow exactly: the `::after` overlay lives on
            the bare link (statically positioned, so it anchors to the relative row), and
            the truncation lives on an INNER span — overflow on the link itself would be a
            trap if it ever gained a position. */}
        <Link
          aria-label={`Open the log page for ${trackLine}`}
          className="track-row-link"
          params={{ logId: finding.logId }}
          to="/log/$logId"
        >
          <span className="saves-row-title block">{trackLine}</span>
        </Link>
        <span className="saves-row-meta">Saved {formatDateLong(finding.savedAt)}</span>
      </span>

      <SavedFindingMenu busy={busy} finding={finding} onRemove={() => void remove()} />
    </li>
  );
}

/**
 * The row's receded actions (the Quiet Surface Rule): the saved note reads first (quiet,
 * non-interactive), then the one action this list owes — Remove. Keyboard-reachable: the
 * trigger is a button and the menu opens on Enter/Space, arrow-navigates its items.
 */
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
            {/* Base UI requires a GroupLabel to live inside a Group — a bare
                DropdownMenuLabel throws MenuGroupContext at runtime (browser-verified;
                the crew-slot menu documents the same trap). */}
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

// One saved set: open it back on /mix (the stored tokens + taste handed to the route's
// loader; the set's `id`/`name` ride as `from`/`fromName` so /mix adopts it as the
// STABLE REFERENCE — every save there PATCHes THIS set), rename it, or delete it
// (behind the same confirm-dialog vocabulary as account deletion — one grammar for
// destructive acts). Rename + delete are plain CSRF fetches then a refresh, the page's
// established mutation shape.
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
    const response = await fetch(`/api/me/saved-sets/${set.id}`, {
      body: JSON.stringify({ name }),
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "PATCH",
    });

    setEditing(false);
    setMessage(response.ok ? "Set renamed." : "Could not rename that set.");
    await refresh();
  }

  async function remove() {
    const response = await fetch(`/api/me/saved-sets/${set.id}`, {
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

// The Sent ledger: what the user submitted, kept clearly apart from the keep-lists above.
// A submission is SENT, not kept, so this is a status register — a row + a status badge,
// no cover and no bookmark affordance. An approved (logged) submission links to the
// finding it became; the rest read as plain lines. The empty state teaches the gesture.
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

// The Saves door: saved findings, saved sets, and the user's own submissions. Lifted
// from the account monolith unchanged (inline play + the ⋮ actions redesign are a
// later phase); it owns its own status line and the two management rows. The
// cover-row skeleton renders only on a client-side switch before the data lands.

import { Link } from "@tanstack/react-router";
import { useState } from "react";
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
import { Input } from "@fluncle/ui/components/input";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { formatDateLong } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { ListEmpty, type SavedFinding, type SavedSet, type SavesDoorData } from "./shared";

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
      <section className="account-section">
        <h2>Saved findings</h2>
        <ListEmpty
          items={saved}
          empty="Nothing saved yet. Tap the bookmark on any finding in the archive and it lands here."
        >
          {saved.map((finding) => (
            <SavedFindingRow
              csrfToken={csrfToken}
              finding={finding}
              key={finding.trackId}
              refresh={refresh}
              setMessage={setSetsMessage}
            />
          ))}
        </ListEmpty>
      </section>

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

      <section className="account-section">
        <h2>Your submissions</h2>
        <ListEmpty items={submissions} empty="No submissions from this account yet.">
          {submissions.map((submission) => (
            <li key={submission.id}>
              {submission.artists.join(", ")} — {submission.title}{" "}
              <Badge variant={submission.status === "approved" ? "default" : "outline"}>
                {submission.status}
              </Badge>
            </li>
          ))}
        </ListEmpty>
      </section>
    </div>
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
          <div className="account-collection-row" key={row}>
            <Skeleton className="account-collection-thumb" />
            <div className="account-collection-body flex-1">
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
 * A saved finding, rendered the way every finding renders: cover first (the
 * recognition cue the user saved it by), coordinate, saved date — plus the one
 * management action this list owes the user: Remove. Removing a save destroys nothing
 * in the archive, so it is a plain action, not a confirm dialog.
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

  async function remove() {
    setBusy(true);

    try {
      const response = await fetch(`/api/me/saved-findings/${finding.trackId}`, {
        headers: { "x-fluncle-csrf": csrfToken },
        method: "DELETE",
      });

      setMessage(response.ok ? "" : "Could not remove that save. Try again in a moment.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="account-collection-row">
      {finding.imageUrl ? (
        <img
          alt=""
          className="account-collection-thumb"
          height={40}
          loading="lazy"
          src={albumCoverAtSize(finding.imageUrl, "small")}
          width={40}
        />
      ) : (
        <span aria-hidden className="account-collection-thumb" />
      )}
      <span className="account-collection-body">
        <Link to="/log/$logId" params={{ logId: finding.logId }}>
          {finding.artists.join(", ")} — {finding.title}
        </Link>
        <span className="account-collection-meta">
          <span className="account-collection-logid">{finding.logId}</span> · Saved{" "}
          {formatDateLong(finding.savedAt)}
          {finding.note ? <> · {finding.note}</> : null}
        </span>
      </span>
      <Button
        aria-label={`Remove ${finding.title} from saves`}
        disabled={busy}
        onClick={() => void remove()}
        size="sm"
        type="button"
        variant="ghost"
      >
        Remove
      </Button>
    </li>
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

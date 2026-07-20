import { EyeIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { authClient } from "@/lib/auth-client";

// The quiet secondary in an artist/label masthead: a signed-in user watches the entity so a
// future digest can reach for it (that digest is deferred — this only SAVES the watch).
//
// THE ACCOUNT NEVER GATES THE FEATURE. A signed-OUT visitor sees NOTHING here — no button,
// no upsell — so the entity page reads identically whether or not you have an account. We
// render only once a session is confirmed (the SaveSetDialog precedent); the anonymous
// watcher equivalent is the entity's own fresh feed (`/artist/<slug>/fresh.xml`), which this
// never touches.
//
// THE SESSION IS RESOLVED CLIENT-SIDE FIRST (`authClient.useSession()`, the shared store the
// crew slot already reads on every page), so a signed-OUT visit costs the origin NOTHING —
// these are PUBLIC pages, and a guaranteed-401 `/api/me/watches` on every anonymous view was
// both a wasted round-trip and the console error behind a Lighthouse best-practices ding.
// Once a session IS known — including a sign-in later in the same session, which re-runs the
// check — the one fetch tells us whether THIS entity is already watched, so the control
// starts on the right face. The label shows the current state ("Watch" ↔ "Watching", the
// ratified "Save finding" → "Saved" family), with `aria-pressed` carrying the toggle state
// and the `aria-label` naming the action for assistive tech.

type Face = "loading" | "not-watching" | "signed-out" | "watching";

type WatchRow = { entityId: string; id: string; kind: string };

export function WatchButton({
  entityId,
  kind,
  name,
}: {
  entityId: string;
  kind: "artist" | "label";
  name: string;
}) {
  const [face, setFace] = useState<Face>("loading");
  // The stored watch's id, held so unwatch can DELETE it by id. Present only while watching.
  const [watchId, setWatchId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;

  useEffect(() => {
    let cancelled = false;

    // No session, no request — and the origin never sees a doomed 401. The store's own
    // "still resolving" flag is deliberately NOT a dependency here: it flips while the
    // signed-in user is already known and would fire a second identical read for nothing,
    // and it buys no render either, since a resolving session and a signed-out one both
    // show the same thing — nothing at all.
    if (!userId) {
      setFace("signed-out");
      setWatchId(undefined);

      return;
    }

    void fetch("/api/me/watches")
      .then(async (res) => {
        if (res.status === 401) {
          if (!cancelled) {
            setFace("signed-out");
          }

          return;
        }

        const body = (await res.json()) as { watches?: WatchRow[] };
        const match = body.watches?.find(
          (watch) => watch.kind === kind && watch.entityId === entityId,
        );

        if (!cancelled) {
          setWatchId(match?.id);
          setFace(match ? "watching" : "not-watching");
        }
      })
      .catch(() => {
        // A failed check just leaves the control hidden — never a broken button.
        if (!cancelled) {
          setFace("signed-out");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [entityId, kind, userId]);

  async function csrf(): Promise<string | undefined> {
    const res = await fetch("/api/me/csrf");

    if (res.status === 401) {
      // The session lapsed between the mount check and the click — send them to sign in.
      window.location.href = "/account";

      return undefined;
    }

    const body = (await res.json()) as { csrfToken?: string };

    return body.csrfToken ?? "";
  }

  async function watch() {
    setBusy(true);

    try {
      const token = await csrf();

      if (token === undefined) {
        return;
      }

      const response = await fetch("/api/me/watches", {
        body: JSON.stringify({ entityId, kind }),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": token },
        method: "POST",
      });

      if (response.status === 401) {
        window.location.href = "/account";

        return;
      }

      if (response.ok) {
        const body = (await response.json()) as { watch?: { id?: string } };

        setWatchId(body.watch?.id);
        setFace("watching");
      }
    } finally {
      setBusy(false);
    }
  }

  async function unwatch() {
    if (!watchId) {
      return;
    }

    setBusy(true);

    try {
      const token = await csrf();

      if (token === undefined) {
        return;
      }

      const response = await fetch(`/api/me/watches/${watchId}`, {
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": token },
        method: "DELETE",
      });

      if (response.status === 401) {
        window.location.href = "/account";

        return;
      }

      if (response.ok) {
        setWatchId(undefined);
        setFace("not-watching");
      }
    } finally {
      setBusy(false);
    }
  }

  if (face === "loading" || face === "signed-out") {
    return null;
  }

  const watching = face === "watching";

  return (
    <Button
      // The accessible name CONTAINS the visible label (WCAG 2.5.3 Label in Name — a speech-input
      // user says "click Watching"); `aria-pressed` alone carries the toggle-to-unwatch semantics.
      aria-label={watching ? `Watching ${name}` : `Watch ${name}`}
      aria-pressed={watching}
      // `mt-4` lives HERE, not on a route wrapper: the null faces (signed-out, loading) must render
      // truly nothing — no empty grid item, no dead masthead space (the never-gates law, visually).
      className="mt-4 shrink-0"
      disabled={busy}
      onClick={() => void (watching ? unwatch() : watch())}
      size="sm"
      type="button"
      variant="outline"
    >
      {/* One glyph, two weights: regular-idle → fill-active (DESIGN.md § Iconography). */}
      <EyeIcon aria-hidden="true" className="size-4" weight={watching ? "fill" : "bold"} />
      {watching ? "Watching" : "Watch"}
    </Button>
  );
}

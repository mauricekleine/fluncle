import { BookmarkSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@fluncle/ui/components/button";

// The quiet secondary in the plate masthead: a signed-in user saves the chain they
// built so it survives the tab. It is NOT the gold primary — Copy set link keeps
// that (the §3.0 one-gold-primary gate); this sits beside it as a plain outline.
//
// THE ACCOUNT NEVER GATES THE TOOL. A signed-OUT visitor sees NOTHING here — no
// button, no upsell — so `/mix` reads identically whether or not you have an
// account; the URL is still the storage. We only render once `/api/me` confirms a
// session, so nothing new appears for the anonymous stranger the tool is built for.
//
// The set + taste come from the URL (the same `?set=`/`?taste=` the share button
// reads), so this needs no state of its own beyond the sign-in check.
export function SaveSetButton({
  serializedSet,
  serializedTaste,
}: {
  serializedSet: string;
  serializedTaste: string;
}) {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/me")
      .then((res) => res.json() as Promise<{ user: unknown }>)
      .then((body) => {
        if (!cancelled) {
          setSignedIn(Boolean(body.user));
        }
      })
      .catch(() => {
        // A failed check just leaves the button hidden — never a broken control.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    try {
      const tokenResponse = await fetch("/api/me/csrf");

      if (tokenResponse.status === 401) {
        // The session lapsed between the check and the click — send them to sign in.
        window.location.href = "/account";
        return;
      }

      const { csrfToken } = (await tokenResponse.json()) as { csrfToken?: string };
      const response = await fetch("/api/me/saved-sets", {
        body: JSON.stringify({ set: serializedSet, taste: serializedTaste }),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken ?? "" },
        method: "POST",
      });

      if (response.ok) {
        toast("Saved to your account. Find it under your findings.");
      } else if (response.status === 401) {
        window.location.href = "/account";
      } else {
        toast("Couldn't save that set.");
      }
    } catch {
      toast("Couldn't save that set.");
    }
  }

  if (!signedIn) {
    return null;
  }

  return (
    <Button className="shrink-0" onClick={() => void save()} type="button" variant="outline">
      <BookmarkSimpleIcon className="size-4" weight="bold" />
      Save set
    </Button>
  );
}

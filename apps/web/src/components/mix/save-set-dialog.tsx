import { BookmarkSimpleIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { buildSaveSetBody, canSaveSet } from "@/lib/mix-save";

// The quiet secondary in the plate masthead: a signed-in user names the chain they built and
// saves it so it survives the tab. It is NOT the gold primary — Copy set link keeps that (the
// §3.0 one-gold-primary gate); this sits beside it as a plain outline.
//
// THE ACCOUNT NEVER GATES THE TOOL. A signed-OUT visitor sees NOTHING here — no button, no
// upsell — so `/mix` reads identically whether or not you have an account. We only render once
// `/api/v1/me` confirms a session, so nothing new appears for the anonymous stranger the tool is
// built for.
//
// THE RULING (2026-07-14) — one save-set contract on web AND mobile:
//  · "Save set" ALWAYS opens a small dialog: a name field, Save, Cancel.
//  · The name PREFILLS with the opened set's name when editing an existing set (the stable
//    reference), empty for a new one.
//  · The `set`/`taste` come from the LIVE CHAIN state (props from the builder's source of
//    truth), NEVER the `?set=` URL param — so save writes what is on screen now.
//  · Opening a saved set makes it the STABLE REFERENCE: every save thereafter PATCHes THAT
//    set (by `reference.id`), regardless of how the chain changed in between. A 404 (the set
//    was deleted elsewhere) falls back to POST-create and adopts the new id — mirroring mobile.
//  · A fresh POST adopts the returned id + entered name, so the second save is also an update.
export function SaveSetDialog({
  chainLength,
  onAdopt,
  reference,
  serializedSet,
  serializedTaste,
}: {
  /** The live chain's length — the empty-chain guard reads it, never the URL. */
  chainLength: number;
  /** Adopt the account set this chain now belongs to, so the next save updates it. */
  onAdopt: (reference: { id: string; name: string }) => void;
  /** The stable reference: the saved set this chain was opened from (or last saved to). */
  reference?: { id: string; name: string };
  /** The live chain, serialized to `?set=` tokens — the save payload. */
  serializedSet: string;
  /** The taste seed, serialized to `?taste=` — rides with the set. */
  serializedTaste: string;
}) {
  const [signedIn, setSignedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/v1/me")
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

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);

    try {
      const tokenResponse = await fetch("/api/v1/me/csrf");

      if (tokenResponse.status === 401) {
        // The session lapsed between the check and the click — send them to sign in.
        window.location.href = "/account";
        return;
      }

      const { csrfToken } = (await tokenResponse.json()) as { csrfToken?: string };
      const headers = { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken ?? "" };
      const body = JSON.stringify(buildSaveSetBody(name, serializedSet, serializedTaste));
      const savedName = name.trim();

      let response: Response;

      if (reference?.id) {
        // The chain is opened from (or already saved to) an account set — UPDATE that set in
        // place. Save never mints siblings of the set you are editing.
        response = await fetch(`/api/v1/me/saved-sets/${reference.id}`, {
          body,
          headers,
          method: "PATCH",
        });

        if (response.status === 404) {
          // The set was deleted on another device — create anew and adopt it.
          response = await fetch("/api/v1/me/saved-sets", { body, headers, method: "POST" });

          if (response.ok) {
            await adopt(response, savedName);
          }
        } else if (response.ok) {
          onAdopt({ id: reference.id, name: savedName });
        }
      } else {
        response = await fetch("/api/v1/me/saved-sets", { body, headers, method: "POST" });

        if (response.ok) {
          await adopt(response, savedName);
        }
      }

      if (response.ok) {
        // A saved set lands under "Saved sets" on /account (NOT under findings), so the old
        // "Find it under your findings." locator was false — dropped, matching mobile.
        toast("Saved to your account.");
        setOpen(false);
      } else if (response.status === 401) {
        window.location.href = "/account";
      } else {
        toast("Couldn't save that set.");
      }
    } catch {
      toast("Couldn't save that set.");
    } finally {
      setBusy(false);
    }
  }

  // Adopt the id a fresh POST returned (+ the entered name) so the second save is an update.
  async function adopt(response: Response, savedName: string) {
    const data = (await response.json()) as { savedSet?: { id?: string } };

    if (typeof data.savedSet?.id === "string") {
      onAdopt({ id: data.savedSet.id, name: savedName });
    }
  }

  if (!signedIn) {
    return null;
  }

  const allowed = canSaveSet({ chainLength, name }) && !busy;

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);

        if (next) {
          // Prefill with the stable reference's name when editing; empty for a new set.
          setName(reference?.name ?? "");
        }
      }}
      open={open}
    >
      <DialogTrigger render={<Button className="shrink-0" variant="outline" />}>
        <BookmarkSimpleIcon aria-hidden="true" className="size-4" weight="bold" />
        Save set
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save set</DialogTitle>
          {/* The overwrite clause shows ONLY when a stable reference exists — for a fresh
              chain there is no "set you opened", and claiming one would be a false locator
              (the same defect class the toast fix removed). */}
          <DialogDescription>
            {reference?.id
              ? "Name it and I'll keep it on your account. I'll update the set you opened."
              : "Name it and I'll keep it on your account."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void save(event)}>
          <Label className="grid gap-2 text-sm font-bold" htmlFor="set-name">
            Set name
            <Input
              autoFocus
              id="set-name"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name this set"
              value={name}
            />
          </Label>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button disabled={!allowed} type="submit">
              {busy ? (
                <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
              ) : (
                <BookmarkSimpleIcon aria-hidden="true" className="size-4" weight="bold" />
              )}
              Save set
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

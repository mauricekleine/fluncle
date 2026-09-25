import { BookmarkSimpleIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { announce } from "@/lib/announce";
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
import { csrfJsonHeaders, fetchCsrfToken } from "@/lib/authed-fetch";
import { buildSaveSetBody, canSaveSet } from "@/lib/mix-save";

export function SaveSetDialog({
  chainLength,
  onAdopt,
  reference,
  serializedSet,
  serializedTaste,
}: {
  chainLength: number;

  onAdopt: (reference: { id: string; name: string }) => void;

  reference?: { id: string; name: string };

  serializedSet: string;

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
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);

    try {
      const csrfToken = await fetchCsrfToken();

      if (csrfToken === undefined) {
        return;
      }

      const headers = csrfJsonHeaders(csrfToken);
      const body = JSON.stringify(buildSaveSetBody(name, serializedSet, serializedTaste));
      const savedName = name.trim();

      let response: Response;

      if (reference?.id) {
        response = await fetch(`/api/v1/me/saved-sets/${reference.id}`, {
          body,
          headers,
          method: "PATCH",
        });

        if (response.status === 404) {
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
        announce("Saved to your account.");
        setOpen(false);
      } else if (response.status === 401) {
        window.location.href = "/account";
      } else {
        announce("Couldn't save that set.");
      }
    } catch {
      announce("Couldn't save that set.");
    } finally {
      setBusy(false);
    }
  }

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
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the only field in a dialog opened to name a set; focus belongs here the moment it opens.
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

// The Settings door on the frequency ladder (the account redesign brief §Settings):
// Preferences → Profile → Email → Newsletter → CLI → Export & deletion, ordered
// most-touched first. Identity's one home is here, as the avatar-led PORTRAIT PLATE
// at the top of Profile (a 64px square mounted in the `.cover-frame` recipe, with
// end-to-end R2 avatar upload). The Newsletter row (operator ruling #5) shows the
// signed-in email's subscription state with a re-subscribe action. Deletion sits
// behind a typed confirmation. The per-door masthead names the room, so the old
// gold "Settings" kicker is gone (it duplicated the masthead).

import {
  CameraIcon,
  EnvelopeSimpleIcon,
  SlidersHorizontalIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { Textarea } from "@fluncle/ui/components/textarea";
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
import { KeyNotationToggle } from "@/components/key-notation-toggle";
import { authClient } from "@/lib/auth-client";
import { formatDateLong } from "@/lib/format";
import { formatKey, syncKeyNotationFromAccount, useKeyNotation } from "@/lib/key-notation";
import { subscribeToNewsletter } from "@/lib/server/newsletter";
import { type NewsletterStatus, readNewsletterStatus } from "@/lib/server/newsletter-status";
import { getPublicSession } from "@/lib/server/public-auth";
import { deleteConfirmationMatches, deleteConfirmationWord } from "./delete-confirm";
import { AccountDisclosure, AccountFence, AccountRow, AccountSection } from "./kit";
import { type AccountUser, Field } from "./shared";

const PRIVACY_LINE = "Email stays private and never appears in public Fluncle surfaces.";

// The Newsletter row's data (Resend is the list-of-record). Read for the signed-in
// user's own email; re-subscribe reuses the public subscribe path in-process. Both
// derive the email from the SESSION, never a client-supplied value.
const getNewsletterStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<NewsletterStatus> => {
    const user = await getPublicSession(getRequest());

    return user ? readNewsletterStatus(user.email) : { available: false };
  },
);

const subscribeNewsletter = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    const request = getRequest();
    const user = await getPublicSession(request);

    if (!user) {
      throw new Error("Sign in to subscribe.");
    }

    await subscribeToNewsletter({ email: user.email }, request);

    return { ok: true };
  },
);

// Center-crop the picked image to a square and downscale to at most `maxSize` on a
// side, re-encoded as a JPEG. Keeps the upload tiny (the server re-checks size +
// dimensions) and gives the plate a square master to mount. Browser-only.
async function downscaleToSquare(file: File, maxSize: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const target = Math.min(side, maxSize);
    const canvas = document.createElement("canvas");

    canvas.width = target;
    canvas.height = target;

    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new Error("Canvas is unavailable.");
    }

    // Draw the centered square region of the source into the whole target canvas.
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      target,
      target,
    );

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );

    if (!blob) {
      throw new Error("Could not encode the image.");
    }

    return blob;
  } finally {
    bitmap.close();
  }
}

export function SettingsDoor({
  csrfToken,
  message,
  refresh,
  setMessage,
  user,
}: {
  csrfToken: string;
  message: string;
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
  user: AccountUser;
}) {
  const [username, setUsername] = useState(user.username ?? "");
  const [name, setName] = useState(user.name);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [emailMessage, setEmailMessage] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [dangerMessage, setDangerMessage] = useState("");
  const [dangerBusy, setDangerBusy] = useState<"" | "delete" | "export">("");
  const [exportText, setExportText] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState("");
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
  const [newsletterBusy, setNewsletterBusy] = useState(false);
  const [newsletterMessage, setNewsletterMessage] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { notation } = useKeyNotation();
  const joined = useMemo(() => formatDateLong(user.createdAt), [user.createdAt]);
  // The dirty-ignition tell (the Fence Ladder): the Profile Save is outline at rest
  // and ignites to gold the moment a field diverges from the loaded value.
  const dirty = username !== (user.username ?? "") || name !== user.name;
  const portraitSrc = avatarPreview ?? user.image;

  // The Newsletter row's live status — an unseeded secondary query (the loader
  // doesn't carry it). Off focus-refetch like the rest of Settings; keyed under
  // ["account"] so the door's refresh() invalidates it too. Hides on degrade.
  const newsletterQuery = useQuery({
    queryFn: () => getNewsletterStatus(),
    queryKey: ["account", "newsletter"],
    refetchOnWindowFocus: false,
  });
  const newsletter = newsletterQuery.data;

  // This panel only mounts for a signed-in user, so force the key-notation store to
  // adopt the profile's stored choice — covering a sign-in mid-session (the one-time
  // sync may have already run anonymously). Toggling the control below then mirrors
  // the change back to the profile.
  useEffect(() => {
    void syncKeyNotationFromAccount({ force: true });
  }, []);

  // Revoke a lingering object-URL preview on unmount so a picked-but-unsaved avatar
  // never leaks a blob URL.
  useEffect(
    () => () => {
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
      }
    },
    [avatarPreview],
  );

  // Resend the verification link to the signed-in user's own email. The confirmation
  // is deliberately uniform (never leaks whether the address is already verified).
  async function resendVerification() {
    setEmailBusy(true);
    setEmailMessage("");

    try {
      await authClient.sendVerificationEmail({ callbackURL: "/account", email: user.email });
      setEmailMessage("Sent. Check your inbox for the verification link.");
    } catch {
      setEmailMessage("Could not send right now. Try again in a moment.");
    } finally {
      setEmailBusy(false);
    }
  }

  async function patchProfile(event: React.FormEvent) {
    event.preventDefault();
    setSettingsBusy(true);

    try {
      const response = await fetch("/api/me/profile", {
        body: JSON.stringify({ name, username }),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "PATCH",
      });

      setSettingsMessage(
        response.ok ? "Profile updated." : ((await response.json()) as { message: string }).message,
      );
      await refresh();
    } finally {
      setSettingsBusy(false);
    }
  }

  // Pick → downscale to a ≤512² square → PUT the bytes to /api/me/avatar. The local
  // preview shows immediately (optimistic); refresh() then re-reads identity so the
  // stored served URL takes over on both the plate and the crew slot.
  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    // Clear the input so re-picking the SAME file still fires a change.
    event.target.value = "";

    if (!file) {
      return;
    }

    setAvatarBusy(true);
    setAvatarMessage("");

    try {
      const blob = await downscaleToSquare(file, 512);

      setAvatarPreview(URL.createObjectURL(blob));

      const response = await fetch("/api/me/avatar", {
        body: blob,
        headers: { "Content-Type": blob.type, "x-fluncle-csrf": csrfToken },
        method: "POST",
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => undefined)) as
          | { message?: string }
          | undefined;

        setAvatarMessage(data?.message ?? "Could not update your photo.");
        setAvatarPreview(undefined);

        return;
      }

      await refresh();
      setAvatarPreview(undefined);
    } catch {
      setAvatarMessage("Could not update your photo. Try again.");
      setAvatarPreview(undefined);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatar() {
    setAvatarBusy(true);
    setAvatarMessage("");

    try {
      const response = await fetch("/api/me/avatar", {
        headers: { "x-fluncle-csrf": csrfToken },
        method: "DELETE",
      });

      if (!response.ok) {
        setAvatarMessage("Could not remove your photo.");

        return;
      }

      setAvatarPreview(undefined);
      await refresh();
    } catch {
      setAvatarMessage("Could not remove your photo.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function subscribe() {
    setNewsletterBusy(true);
    setNewsletterMessage("");

    try {
      await subscribeNewsletter();
      await newsletterQuery.refetch();
      setNewsletterMessage("You're on the list.");
    } catch {
      setNewsletterMessage("Could not subscribe right now. Try again in a moment.");
    } finally {
      setNewsletterBusy(false);
    }
  }

  async function exportData() {
    setDangerBusy("export");
    setDangerMessage("");

    try {
      const response = await fetch("/api/me/export", {
        body: "{}",
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "POST",
      });
      const data = (await response.json()) as { export?: unknown };
      const text = JSON.stringify(data.export ?? data, null, 2);

      setExportText(text);
      // "Export" means a FILE lands — the textarea stays as the preview, but the
      // download is the deliverable.
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.download = "fluncle-account.json";
      anchor.href = url;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setDangerMessage("Could not export right now. Try again in a moment.");
    } finally {
      setDangerBusy("");
    }
  }

  async function deleteData() {
    setDangerBusy("delete");

    try {
      const response = await fetch("/api/me/delete", {
        body: "{}",
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "POST",
      });

      setMessage(
        response.ok
          ? "Account deleted. Anonymous mode is still here."
          : "Could not delete account.",
      );
      await refresh();
    } finally {
      setDangerBusy("");
    }
  }

  const deleteWord = deleteConfirmationWord(user.username);

  return (
    <div className="account-tab-panel">
      <AccountSection
        helper="Pick how keys read: Scales or Camelot. The choice saves to your account and follows you onto every device you sign in on."
        icon={<SlidersHorizontalIcon />}
        label="Preferences"
      >
        <div className="account-field">
          <span className="text-sm font-medium">Key notation</span>
          <KeyNotationToggle />
          <p aria-live="polite" className="account-muted">
            Keys read as {formatKey("G# minor", notation)}.
          </p>
        </div>
      </AccountSection>

      <AccountSection
        action={
          <Button disabled={settingsBusy} type="submit" variant={dirty ? "default" : "outline"}>
            {settingsBusy ? "Updating…" : "Update profile"}
          </Button>
        }
        helper="Your handle and the name shown in the top bar."
        icon={<UserIcon />}
        label="Profile"
        onSubmit={(event) => void patchProfile(event)}
        status={
          settingsMessage ? (
            <span aria-live="polite">{settingsMessage}</span>
          ) : (
            <span>Joined {joined}</span>
          )
        }
      >
        {/* The portrait plate (the brief §identity): a 64px SQUARE avatar mounted in
            the .cover-frame recipe (sun-lit edge, eclipse-gradient mat when empty),
            beside the name, handle, and join date. The "Change photo" overlay reveals
            on hover/focus and stays up on touch (the .preview-art-btn pattern). */}
        <div className="account-portrait-plate">
          <div className="account-portrait cover-frame">
            {portraitSrc ? <img alt="" className="account-portrait-img" src={portraitSrc} /> : null}
            <button
              aria-label="Change photo"
              className="account-portrait-change"
              disabled={avatarBusy}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <CameraIcon aria-hidden weight="bold" />
            </button>
            {/* The real picker, visually hidden and out of the tab order — the labeled
                button above is the single operable control (it forwards the click). */}
            <input
              accept="image/*"
              aria-hidden
              className="sr-only"
              onChange={(event) => void onPickFile(event)}
              ref={fileInputRef}
              tabIndex={-1}
              type="file"
            />
          </div>
          <div className="account-portrait-id">
            <span className="account-portrait-name">{user.name}</span>
            {user.username ? (
              <span className="account-portrait-handle">@{user.username}</span>
            ) : null}
            <span className="account-portrait-since">
              {/* The enlistment stamp (operator ruling #1): cream, never gold — a crew
                  member is not certified music. A legacy row shows plain "crew since"
                  until the one-time backfill stamps it. */}
              {user.crewNumber !== undefined ? (
                <>
                  <span className="account-portrait-crew">Crew Nº{user.crewNumber}</span> ·{" "}
                </>
              ) : null}
              crew since {joined}
            </span>
            {user.image ? (
              <button
                className="account-portrait-remove"
                disabled={avatarBusy}
                onClick={() => void removeAvatar()}
                type="button"
              >
                Remove photo
              </button>
            ) : null}
            {avatarMessage ? (
              <p aria-live="polite" className="account-muted">
                {avatarMessage}
              </p>
            ) : null}
          </div>
        </div>

        {/* The two-name model: Username is the handle, Name is what shows in the top
            bar. No third field — a "display name" next to both was one name too many. */}
        <Field
          hint="Your handle. 3–24 characters: lowercase letters, numbers, underscores."
          label="Username"
        >
          <Input value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field hint="Shown in the top bar and on your account." label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
      </AccountSection>

      {user.emailVerified ? (
        <AccountRow
          control={<span>{user.email} · verified</span>}
          helper={PRIVACY_LINE}
          label="Email"
        />
      ) : (
        <AccountSection
          action={
            <Button
              disabled={emailBusy}
              onClick={() => void resendVerification()}
              type="button"
              variant="outline"
            >
              {emailBusy ? "Sending…" : "Resend verification email"}
            </Button>
          }
          helper={PRIVACY_LINE}
          icon={<EnvelopeSimpleIcon />}
          label="Email"
          status={emailMessage ? <span aria-live="polite">{emailMessage}</span> : undefined}
        >
          <p className="account-muted">
            {user.email} · not verified yet. Nothing is locked without it. Verifying just keeps the
            door yours.
          </p>
        </AccountSection>
      )}

      {/* The Newsletter row (operator ruling #5): subscription state for the signed-in
          email, with a re-subscribe action for the unsubscribed. Resend is the list of
          record; the row hides entirely when Resend is unprovisioned. */}
      {newsletter?.available ? (
        <AccountRow
          control={
            newsletter.subscribed ? (
              <span>Subscribed</span>
            ) : (
              <Button
                disabled={newsletterBusy}
                onClick={() => void subscribe()}
                type="button"
                variant="outline"
              >
                {newsletterBusy ? "Subscribing…" : "Subscribe"}
              </Button>
            )
          }
          helper={
            newsletterMessage ? (
              <span aria-live="polite">{newsletterMessage}</span>
            ) : (
              "The Friday drop. One email a week, only when there's something worth hearing."
            )
          }
          label="Newsletter"
        />
      ) : null}

      {/* Developer content recedes behind a disclosure (the Quiet Surface Rule) —
          present for the crew that wants it, invisible to everyone else. */}
      <AccountDisclosure summary="Link the CLI">
        <p className="account-muted">
          Got the <code>fluncle</code> CLI? Run <code>fluncle login</code> in your terminal to link
          this device and sync your Galaxy from the command line. I&rsquo;ll send you back here to
          approve it.
        </p>
      </AccountDisclosure>

      <AccountFence label="Export and deletion">
        <p className="account-muted">
          Export includes private progress, saved findings, saved sets, and signed-in submissions.
          Deletion removes private progress, saves, and sets, revokes sessions, and unlinks
          submissions from this account.
        </p>
        <div className="account-row">
          <Button
            disabled={dangerBusy !== ""}
            type="button"
            variant="outline"
            onClick={() => void exportData()}
          >
            {dangerBusy === "export" ? "Exporting…" : "Export data"}
          </Button>
          <AlertDialog
            open={deleteOpen}
            onOpenChange={(next) => {
              setDeleteOpen(next);
              // Re-arm the gate every time the dialog opens or closes.
              setDeleteConfirm("");
            }}
          >
            <AlertDialogTrigger
              render={
                <Button disabled={dangerBusy !== ""} type="button" variant="destructive">
                  {dangerBusy === "delete" ? "Deleting…" : "Delete account"}
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this account?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes your private progress, saves, and sets, revokes your sessions, and
                  unlinks submissions from this account. It cannot be undone. The archive stays, and
                  anonymous mode is still here.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {/* Typed confirmation (the Fence rule): the destructive button stays
                  disabled until the account's handle (or "delete") is typed back. */}
              <Field label={`Type ${deleteWord} to confirm`}>
                <Input
                  autoComplete="off"
                  onChange={(event) => setDeleteConfirm(event.target.value)}
                  value={deleteConfirm}
                />
              </Field>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={
                    dangerBusy !== "" || !deleteConfirmationMatches(deleteConfirm, user.username)
                  }
                  variant="destructive"
                  onClick={() => void deleteData()}
                >
                  Delete account
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {dangerMessage || message ? (
          <p aria-live="polite" className="account-muted">
            {dangerMessage || message}
          </p>
        ) : null}
        {exportText ? (
          <Textarea readOnly className="min-h-48 font-mono text-xs" value={exportText} />
        ) : null}
      </AccountFence>
    </div>
  );
}

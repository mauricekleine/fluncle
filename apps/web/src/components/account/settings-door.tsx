// The Settings door: profile, email, preferences, the CLI pointer, and — deliberately
// last — export & deletion. Phase A wraps each existing section in the Fence Ladder
// kit (Class A/B/C/D) without a behavior change: the same mutations, the same order
// (Profile → Email → Preferences → CLI → danger, the operator's precedent), only the
// enclosure now encodes each concern's consequence. Identity's one home is here now —
// the joined date rides beside the profile fields, and the "email stays private" line
// is the Email row's helper (the repeated identity block on the page shell is gone).

import { EnvelopeSimpleIcon, SlidersHorizontalIcon, UserIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
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
import { AccountDisclosure, AccountFence, AccountRow, AccountSection } from "./kit";
import { type AccountUser, Field } from "./shared";

const PRIVACY_LINE = "Email stays private and never appears in public Fluncle surfaces.";

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
  const { notation } = useKeyNotation();
  const joined = useMemo(() => formatDateLong(user.createdAt), [user.createdAt]);
  // The dirty-ignition tell (the Fence Ladder): the Profile Save is outline at rest
  // and ignites to gold the moment a field diverges from the loaded value.
  const dirty = username !== (user.username ?? "") || name !== user.name;

  // This panel only mounts for a signed-in user, so force the key-notation store to
  // adopt the profile's stored choice — covering a sign-in mid-session (the one-time
  // sync may have already run anonymously). Toggling the control below then mirrors
  // the change back to the profile.
  useEffect(() => {
    void syncKeyNotationFromAccount({ force: true });
  }, []);

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

  return (
    <div className="account-tab-panel">
      <p className="account-kicker">Settings</p>

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
        {/* The two-name model: Username is the handle, Name is what shows in the top
            bar. No third field — a "display name" next to both was one name too many. */}
        <Field label="Username">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <p className="account-muted text-xs">
          Your handle. 3–24 characters: lowercase letters, numbers, underscores.
        </p>
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <p className="account-muted text-xs">Shown in the top bar and on your account.</p>
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
          <AlertDialog>
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
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void deleteData()}>
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

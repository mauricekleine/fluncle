// The shared vocabulary of the account area: the honest types every door and the
// route agree on (one home for `Me`, never re-declared per module), plus the three
// tiny primitives the doors reuse (a labelled field, a metric, an empty-or-list
// wrapper). The section KIT (Class A–D enclosures) lives next door in kit.tsx; this
// module is the plumbing beneath it.

import { cloneElement, isValidElement, useId } from "react";
import { Label } from "@fluncle/ui/components/label";

/**
 * The `/me` identity shape (the `meResponse` body). `googleEnabled` gates the
 * "Continue with Google" button so it never renders dead; it is present whether or
 * not there is a session.
 */
export type Me = {
  googleEnabled: boolean;
  ok: true;
  user: AccountUser | null;
};

/** The signed-in user as the account surfaces read them (the `PublicUser` subset). */
export type AccountUser = {
  createdAt: string;
  // The enlistment ordinal (Crew №NNN) — absent on a legacy row until the backfill.
  crewNumber?: number;
  displayUsername?: string;
  email: string;
  emailVerified: boolean;
  id: string;
  image?: string;
  name: string;
  username?: string;
};

export type Progress = {
  collectedLogIds: string[];
  deaths: number;
  wins: number;
};

export type CollectionItem = {
  artists: string[];
  firstCollectedAt: string;
  galaxyName?: string;
  galaxySlug?: string;
  imageUrl?: string;
  logId: string;
  title: string;
  trackId: string;
};

export type GalaxyCompletion = {
  collected: number;
  name: string;
  slug: string;
  total: number;
};

export type Collection = {
  collection: CollectionItem[];
  galaxies: GalaxyCompletion[];
};

export type SavedFinding = {
  artists: string[];
  imageUrl?: string;
  logId: string;
  note?: string;
  savedAt: string;
  title: string;
  trackId: string;
};

// The submission status arrives already folded to the reader's vocabulary
// ("logged" / "passed_on" / "pending_review", from `listUserSubmissions`). Typed as
// a plain string so the badge's rendering carries over from the monolith unchanged.
// `logId` rides only on an approved (logged) submission whose recording became a
// certified finding — the Sent ledger links that row to `/log/<id>`.
export type Submission = {
  artists: string[];
  createdAt: string;
  id: string;
  logId?: string;
  status: string;
  title: string;
};

export type SavedSet = {
  createdAt: string;
  id: string;
  name: string;
  setTokens: string;
  taste?: string;
  updatedAt: string;
};

/** The three signed-in doors. Absent from the URL = the Galaxy (the default view). */
export type AccountTab = "galaxy" | "saves" | "settings";

/** Identity carried on every render: the current session + its mutation token. */
export type AccountIdentity = {
  csrfToken: string;
  me: Me;
};

/**
 * The active door's payload, discriminated by `tab`. Only ONE door's data is ever
 * fetched (the loader/serverFn does the narrowing); settings rides on `me`, so it
 * carries nothing extra.
 */
export type GalaxyDoorData = {
  collection?: Collection;
  progress?: Progress;
  tab: "galaxy";
};

export type SavesDoorData = {
  saved: SavedFinding[];
  sets: SavedSet[];
  submissions: Submission[];
  tab: "saves";
};

export type SettingsDoorData = {
  tab: "settings";
};

export type DoorData = GalaxyDoorData | SavesDoorData | SettingsDoorData;

/** Only `saves` and `settings` ride in the URL; a bare `/account` is the Galaxy. */
export function parseAccountTab(value: unknown): AccountTab | undefined {
  return value === "saves" || value === "settings" ? value : undefined;
}

export function Field({
  children,
  hint,
  label,
}: {
  children: React.ReactElement<{ "aria-describedby"?: string; id?: string }>;
  /** Helper text under the control, announced with it (`aria-describedby`). */
  hint?: string;
  label: string;
}) {
  // useId keeps the id unique even when two forms carry the same label text (the auth
  // and settings forms both have a "Username" field).
  const id = `${useId()}-${label.toLowerCase().replaceAll(" ", "-")}`;
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="account-field">
      <Label htmlFor={id}>{label}</Label>
      {isValidElement(children)
        ? cloneElement(children, { "aria-describedby": hintId, id })
        : children}
      {hint ? (
        <p className="account-muted text-xs" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="account-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function ListEmpty<T>({
  children,
  empty,
  items,
}: {
  children: React.ReactNode;
  empty: string;
  items: T[];
}) {
  return items.length > 0 ? (
    <ul className="account-list">{children}</ul>
  ) : (
    <p className="account-muted">{empty}</p>
  );
}

import { cloneElement, isValidElement, useId } from "react";
import { Label } from "@fluncle/ui/components/label";

export type Me = {
  googleEnabled: boolean;
  ok: true;
  user: AccountUser | null;
};

export type AccountUser = {
  createdAt: string;

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
  logId?: string;
  note?: string;
  savedAt: string;
  title: string;
  trackId: string;
};

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

export type Watch = {
  createdAt: string;
  entityId: string;
  id: string;
  includeSimilar: boolean;
  kind: "artist" | "label";
  name: string;
  slug: string;
};

export type AccountTab = "galaxy" | "saves" | "settings";

export type AccountIdentity = {
  csrfToken: string;
  me: Me;
};

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
  watches: Watch[];
};

export type SettingsDoorData = {
  tab: "settings";
};

export type DoorData = GalaxyDoorData | SavesDoorData | SettingsDoorData;

export function parseAccountTab(value: unknown): AccountTab | undefined {
  return value === "saves" || value === "settings" ? value : undefined;
}

export function Field({
  children,
  hint,
  label,
}: {
  children: React.ReactElement<{ "aria-describedby"?: string; id?: string }>;

  hint?: string;
  label: string;
}) {
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

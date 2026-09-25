export type FindingKind = "mixtape" | "track";

export type FindingMeta = {
  album?: string;
  albumImageUrl?: string;
  artists?: string[];
  bpm?: number;

  foundAt?: string;
  key?: string;
  kind: FindingKind;
  label?: string;
  logId?: string;

  memberCount?: number;
  spotifyUrl?: string;
  title?: string;
  webUrl?: string;
  year?: string;
};

export type FetchState = "error" | "loading" | "ready";

export type DetectedFinding = {
  id: string;
  meta?: FindingMeta;

  raw: string;
  state: FetchState;
};

export type GetFindingsMessage = { type: "lens:get-findings" };

export type FindingsResponse = { findings: DetectedFinding[] };

export type BadgeMessage = { count: number; type: "lens:badge" };

// THE FEATURE-MODULE CONTRACT (HELM-CONTRACT.md). A feature lives at
// src/features/<id>/ as three files:
//
//   manifest.ts — `export const manifest: FeatureManifest` ({ id, title, machines, order })
//   server.ts   — `export function registerRoutes(app: HelmApp): void` (its /api/<id>/… routes)
//   panel.tsx   — the UI panel, default export, rendered when the machine matches
//
// plus ONE line in src/features/index.ts (the id in `featureIds` — the only shared
// touch point between units). Everything here is types; importing this file pulls
// no runtime into either bundle.

import { type FeatureMachine, type MachineId } from "../contract";
import { type RouteHandler } from "../server/router";
import { type RunRegistry } from "../server/runs";

export type FeatureManifest = {
  /** The feature's directory name AND its /api/<id>/… route prefix. */
  id: string;
  /** Which Macs show this panel (AGENTS.md's m2/m5 split). */
  machines: FeatureMachine[];
  /** Rail position, ascending. */
  order: number;
  /** What the rail calls it. Sentence case. */
  title: string;
};

/**
 * The Fluncle admin API, in-process — apps/cli's stored credentials presented by
 * the daemon itself (apps/cli/src/env.ts + api.ts imported server-side). The
 * token never reaches the UI; features call these from server.ts only.
 */
export type AdminClient = {
  del<T>(path: string): Promise<T>;
  get<T>(path: string): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  postForm<T>(path: string, form: FormData): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
};

/** What the daemon hands every feature's registerRoutes. */
export type HelmContext = {
  admin: AdminClient;
  machine: MachineId;
  machineBrand: string;
  /** macOS notification via osascript — works windowless (launchd). */
  notify(title: string, body: string): Promise<void>;
  /** The action-streaming core: runStreamed + the per-run stream/kill routes. */
  runs: RunRegistry;
  startedAt: number;
};

export type HelmApp = {
  context: HelmContext;
  /** Register GET /api/<id>/… — patterns take `:param` captures. */
  get(pattern: string, handler: RouteHandler): void;
  /** Register POST /api/<id>/… */
  post(pattern: string, handler: RouteHandler): void;
};

export type RegisterRoutes = (app: HelmApp) => void;

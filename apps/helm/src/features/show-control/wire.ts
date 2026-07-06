// The show-control wire contract — the shapes the daemon side (server.ts) and the
// glass side (panel.tsx) both import, plus the pure run-selection helpers behind the
// single-show guard. The glass ports are singular (4173/4180), so the station raises
// at most ONE show at a time; these helpers pick the run that owns them.

import { type RunSummary } from "../../contract";
import { type ShowChoice } from "./choices";

/** The feature id — its `/api/<id>/…` prefix AND the `feature` its runs are scoped to. */
export const SHOW_FEATURE_ID = "show-control";

/** The live-glass links the daemon computes server-side (the phone remote wants the LAN IP). */
export type ShowLinks = {
  /** The glass on the operator's own machine. */
  glass: string;
  /** The phone remote on the LAN, or null when the daemon has no LAN address to offer. */
  remote: string | null;
};

/** GET /api/show-control/choices — the pickable tracklists (empty + `reachable:false` if the admin API is silent). */
export type ChoicesResponse = {
  choices: ShowChoice[];
  ok: true;
  reachable: boolean;
};

/** GET /api/show-control/active — the show run to re-attach to on reload (running, else most recent), + the links. */
export type ActiveResponse = {
  links: ShowLinks;
  ok: true;
  run: RunSummary | null;
};

/** POST /api/show-control/raise body — the `--plan` ref + the force flag ("depart anyway"). */
export type RaiseRequest = {
  force?: boolean;
  ref: string;
};

/** The 409 body when a show already holds the ports — the panel surfaces the running one. */
export type AlreadyRunningResponse = {
  code: "already_running";
  message: string;
  runId: string;
};

/**
 * The show run currently holding the glass ports, if any — the single-show guard. A show
 * run is `feature === SHOW_FEATURE_ID` and `status === "running"`.
 */
export function findRunningShow(runs: readonly RunSummary[]): RunSummary | undefined {
  return runs.find((run) => run.feature === SHOW_FEATURE_ID && run.status === "running");
}

/**
 * The show run the panel re-attaches to on load: the running one if a show is up, else the
 * most recent show run (so a finished pre-flight — holds and all — survives a reload). The
 * registry lists newest-first, so the first match is the most recent.
 */
export function pickActiveShow(runs: readonly RunSummary[]): RunSummary | undefined {
  return findRunningShow(runs) ?? runs.find((run) => run.feature === SHOW_FEATURE_ID);
}

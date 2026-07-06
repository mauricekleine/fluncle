// The Helm wire contract — the one file both sides of the app (the Bun daemon and
// the React glass) and every feature module import. Ports, machine identity, run
// state, and the SSE event names live here so a feature never re-invents them.
//
// Ports registry (HELM-CONTRACT.md): 4190 is the helm daemon. 4173/4180 are the
// live glass + bridge (packages/live) — the helm SPAWNS the show, it never serves
// those. 4191 is the Vite dev server (HMR), proxying /api to the daemon.

export const HELM_PORT = 4190;
export const HELM_DEV_PORT = 4191;

/** Which of the two operator Macs the daemon woke up on (AGENTS.md's machine split). */
export type MachineId = "m2" | "m5" | "unknown";

/** The machines a feature may claim in its manifest ("unknown" gates nothing). */
export type FeatureMachine = Exclude<MachineId, "unknown">;

/** A run is running until its child exits: 0 is ok, anything else is failed. */
export type RunStatus = "failed" | "ok" | "running";

/** Where a run line came from. `system` lines are the registry's own narration. */
export type RunStream = "stderr" | "stdout" | "system";

/** One line of a run's output, in arrival order (`seq` is per-run, gapless). */
export type RunLine = {
  seq: number;
  stream: RunStream;
  text: string;
};

/** The run-registry snapshot the drawer lists — everything but the line buffer. */
export type RunSummary = {
  argv: string[];
  endedAt: number | null;
  exitCode: number | null;
  feature: string;
  id: string;
  startedAt: number;
  status: RunStatus;
  title: string;
};

// The SSE stream (`GET /api/<feature>/runs/<runId>/stream`) speaks two events:
// `line` (a RunLine, replayed from the buffer first, then live) and `status`
// (a RunSummary, sent on every status change; the stream closes after the final
// one). Comment frames (`: hold`) are keepalives — ignore them.
export const RUN_SSE_LINE_EVENT = "line";
export const RUN_SSE_STATUS_EVENT = "status";

/** GET /api/machine */
export type MachineResponse = {
  brand: string;
  machine: MachineId;
};

/** GET /api/health */
export type HealthResponse = {
  adminTokenAboard: boolean;
  machine: MachineId;
  ok: true;
  pid: number;
  port: number;
  startedAt: number;
  uptimeMs: number;
};

/** GET /api/runs */
export type RunsResponse = {
  runs: RunSummary[];
};

/** The action-route reply shape: a started run, streamable by id. */
export type RunStartedResponse = {
  runId: string;
};

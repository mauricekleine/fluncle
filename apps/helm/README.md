# Fluncle's Helm

The operator's mission control (`apps/helm`): a LAN-local Bun daemon plus an on-brand app window, one per machine (the M5 and the M2 — AGENTS.md's two-Mac split). The daemon owns the machine identity, the run registry (spawned operator actions streamed live over SSE), macOS notifications, and the in-process admin bridge; the glass is a React SPA on `@fluncle/ui` that renders feature panels against it. Frame-agnostic by design: v1 is a Chrome app-mode window, and a tray shim could wrap the same daemon later without it noticing.

## The shape

- **Daemon** — `src/server.ts`, `Bun.serve` on **:4190**. Binds `127.0.0.1` by default; `FLUNCLE_HELM_LAN=1` binds the LAN/tailnet (the `packages/live` precedent — the phone companion path). LAN mode is authenticated: a loopback request (verified by remote address, never headers) passes free; any other peer must present the **helm key** — `FLUNCLE_HELM_KEY`, or minted once and persisted 0600 at `~/.config/fluncle/helm.key` — as `Authorization: Bearer <key>` or `?key=` (EventSource can't set headers), else 401. At boot in LAN mode the daemon prints the phone URL with the key embedded. Every request's Host (and Origin, when present) must also sit on the daemon's own allowlist (`src/server/auth.ts`) — DNS-rebinding and cross-origin POSTs answer 403. `FLUNCLE_HELM_PORT` overrides the port. Ports **4173/4180 are never touched** — those are the live glass + bridge; the helm SPAWNS the show, it never serves it.
- **Glass** — the React SPA in `src/ui/`, built by Vite (`bun run build` → `dist/`, served statically by the daemon). Dark-only Warm Dark on the shared design system (`@fluncle/ui/globals.css` + the `@source` registration in `src/styles.css`), Phosphor icons, Oxanium/Monaspace Krypton self-hosted.
- **Launcher** — `fluncle helm` (apps/cli): starts-or-focuses — daemon healthy? open the app window (Chrome `--app`, default browser as fallback); otherwise build-if-needed, boot the daemon (logs to `~/Library/Logs/fluncle-helm.log`), wait for `/api/health`, open. `fluncle helm install|uninstall` manages the launchd LaunchAgent (`com.fluncle.helm`, RunAtLoad, crash-restart) so the daemon rises at login and runs windowless.
- **Auth** — the daemon imports `apps/cli/src/env.ts` + `api.ts` in-process and presents the CLI's stored admin credentials itself. The token never travels to the UI; feature panels call their own `/api/<id>/…` routes and the feature's `server.ts` calls `context.admin` server-side.
- **Machine** — `sysctl -n machdep.cpu.brand_string` → `m5 | m2 | unknown` (`src/server/machine.ts`), exposed as `GET /api/machine` and gating feature visibility. An unknown machine is never locked out; it sees every station and the badge says so.

## The /api core

| Route                               | What                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/machine`                  | `{ brand, machine }`                                                                      |
| `GET /api/health`                   | `{ ok, machine, pid, port, startedAt, uptimeMs, adminTokenAboard }`                       |
| `GET /api/features`                 | the machine-gated station manifests, rail-ordered                                         |
| `GET /api/runs`                     | every run the registry knows, newest first (the drawer's list)                            |
| `GET /api/<id>/runs/<runId>/stream` | SSE: buffered `line` events replayed, then live; a final `status` event closes the stream |
| `POST /api/<id>/runs/<runId>/kill`  | SIGINT the child (SIGKILL after an 8s grace)                                              |

## The feature-module contract

A feature lives at `src/features/<id>/` as three files, plus **one line** in `src/features/index.ts` — the only shared touch point between units:

```
src/features/<id>/manifest.ts   export const manifest: FeatureManifest
                                // { id, title, machines: Array<"m2"|"m5">, order }
src/features/<id>/server.ts     export function registerRoutes(app: HelmApp): void
src/features/<id>/panel.tsx     export default function Panel() { … }
```

```ts
// src/features/index.ts — add your id to the array; that is the whole registration.
export const featureIds = ["pulse-lite", "<your-id>"] as const;
```

The daemon loads `manifest.ts` + `server.ts` by that convention (and enforces `manifest.id === <id>`); the glass lazy-loads `panel.tsx` the same way, and only for stations `/api/features` says are visible on this machine. All contract types are in `src/features/types.ts` (`FeatureManifest`, `HelmApp`, `HelmContext`, `AdminClient`).

What `registerRoutes(app)` gets on `app.context`:

- `admin` — the in-process Fluncle admin API (`get/post/patch/put/del/postForm`), CLI-credentialed, server-side only.
- `runs.runStreamed(argv, opts)` — spawn a long action and get `{ runId }` back; the per-run stream/kill routes above are mounted once, for every feature. Runs are feature-scoped: one station can never stream or kill another's work. Spawns run local-direct under the daemon (the operator's own process class — the multi-GB upload rule is satisfied by construction). Every run leads its **own process group** (kills reap grandchildren too) and gets a **least-privilege env** — PATH/HOME/TMPDIR/LANG plus `opts.env`, never the daemon's own `process.env`; a leg that genuinely needs the CLI credentials opts in with `adminToken: true`. On daemon exit the registry stands every group down escalatingly and AWAITS it: SIGINT → bounded grace → SIGKILL → bounded grace → go. Wrong-machine action POSTs (a station whose manifest excludes this Mac) answer 403 server-side, not just by panel visibility.
- `notify(title, body)` — a macOS notification via osascript; works windowless under launchd.
- `machine`, `machineBrand`, `startedAt`.

Panel side: `useHelm()` (`src/ui/helm-context.tsx`) gives a panel `{ machine, machineBrand, openRun }` — start an action with `apiPost`, hand its `runId` to `openRun(feature, runId)`, and the run drawer opens on the live stream. Pre-flight tokens in the output (`[clear] / [hold] / [dark]`, the `packages/live/src/show.ts` vocabulary) render as status rows; everything else is the monospace log. `pulse-lite` is the end-to-end reference implementation of all of this.

## Run it

```bash
bun run --cwd apps/helm dev     # daemon (watch, :4190) + Vite HMR (:4191, /api proxied)
bun run --cwd apps/helm build   # the glass → dist/
bun run --cwd apps/helm start   # the daemon, serving dist/ (what launchd runs)
bun run --cwd apps/helm test    # the pure parts: machine parse, run registry, SSE framing, gating
fluncle helm                    # start-or-focus, from anywhere in the repo
fluncle helm install            # LaunchAgent: the daemon rises at login
```

Outside the repo, point the launcher at the checkout with `FLUNCLE_HELM_DIR=<path>/apps/helm`.

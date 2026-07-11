# Smoke Routine (the nightly admin-smoke diagnosis — a desktop-app local routine)

The **smoke routine** is a scheduled Claude agent that runs the three admin browser smokes every night and either confirms green or diagnoses the failure. It is a **desktop-app local routine**, not a box cron: it runs in the Claude desktop app on the operator's Mac, in the **main checkout**, and — by design — only while that machine is awake and the app is open. It is deliberately not on rave-02: the smokes need a seeded, prod-shaped local DB, a real Chrome, and the `.dev.vars` secrets, none of which live on the box (see [admin-shell.md](../admin-shell.md) §Verifying — "their scheduled home is a timer on the operator's machine").

The routine is thin: it calls one deterministic wrapper, reads one summary line, and only then does any thinking. The wrapper (`apps/web/scripts/smoke-routine.ts`, the `smoke:routine` script) owns all the stack mechanics; the routine owns the judgment.

## The wrapper (`bun run --cwd apps/web smoke:routine`)

`smoke:routine` boots a fully isolated dev stack on **dedicated ports** — a `turso dev` libSQL server over this checkout's seeded `.dev/local.db` (`:8899`) plus a Vite dev server (`:3120`) — runs the three smokes (`shell`, `queue` with `SEED=1`, `touch`) sequentially against it, tears the stack down, and prints one machine-parseable final line:

```
SMOKE ROUTINE: shell=PASS|FAIL queue=PASS|FAIL touch=PASS|FAIL
```

It exits `0` iff all three passed. It continues past a failing smoke so all three always report. Preflight fails fast with one clear reason if `.dev.vars` or the seeded `.dev/local.db` is missing, or if either dedicated port is already listening (it refuses, never kills).

The DB-URL contract is load-bearing and non-obvious: the dev worker runs under `@cloudflare/vite-plugin`, which injects `apps/web/.dev.vars` as the worker's bindings, so a `TURSO_DATABASE_URL` passed as a process env var to the Vite child is ignored by the worker. The wrapper therefore transiently rewrites `.dev.vars`'s `TURSO_DATABASE_URL` to the dedicated libSQL port — the one file both the worker (via the plugin) and the smokes (via `loadDevVars`) read — backing up the original under the gitignored `.dev/` and restoring it in a `finally` and on every signal, self-healing from a leftover backup on the next run.

## The routine's form fields

Create it in the desktop app's routines UI with exactly these:

- **Name:** `nightly-admin-smokes`
- **Folder:** the main checkout (where the seeded DB and `.dev.vars` live).
- **Worktree:** UNCHECKED. The seeded `.dev/local.db` and `.dev.vars` exist only in the main checkout; a fresh worktree has neither, so the routine must run in the main checkout itself.
- **Schedule:** daily, ~05:00.

## The canonical instructions block

Paste this verbatim into the routine's instructions field. It is the routine's constitution; keep it byte-stable.

```
Run the nightly admin-smoke diagnosis.

1. `git pull --ff-only`, then `bun run --cwd apps/web smoke:routine`. It boots an isolated dev stack on dedicated ports, runs the three admin browser smokes (shell, queue with SEED=1, touch), tears down, and ends with one summary line: `SMOKE ROUTINE: shell=… queue=… touch=…`.
2. ALL PASS → reply with that one line and stop. Nothing else.
3. Any FAIL → diagnose before reporting. For each failing assertion: read the assertion and the UI/server code it exercises, and `git log` the surfaces involved. Classify:
   - FIXTURE ROT — the product changed deliberately (find and cite the commit) and the smoke is stale. Fix it: edit ONLY files under `apps/web/tests/browser/`, re-run `smoke:routine` to green, commit with a `test(smokes): …` message. Do NOT push. Include the commit hash in your report.
   - SUSPECTED REGRESSION — no deliberate change explains it. Touch NOTHING. Report the failing assertion, the suspect commit(s), and what a human should inspect.
4. Report: one line per smoke — PASS / ROT-FIXED <commit> / REGRESSION-SUSPECTED — then detail only for non-PASS.

Hard rails: never modify anything outside `apps/web/tests/browser/`; NEVER push (a push to main deploys); if the dev stack fails to boot, report the boot error verbatim and stop — do not debug infrastructure.
```

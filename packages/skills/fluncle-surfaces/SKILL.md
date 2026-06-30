---
name: fluncle-surfaces
description: "Add, change, or audit a Fluncle SURFACE — any place Fluncle is reachable (a web route, subdomain, /api/v1 endpoint, feed, discovery/well-known map, the DNS zone, the SSH rave terminal, the MCP server, a fluncle CLI command, or an on-box Hermes cron). Use when wiring up a NEW surface: register it in @fluncle/registry plus everywhere it fans out (the /status probe, the homepage dev-row/nav, the SSH menu, llms.txt, the sitemap, the surfaces-doctrine doc, the naming-conventions registry); or when changing a surface's per-context display weight (web/ssh/cli/status), probeConfig, or exposedContent. Trigger on 'add a surface', 'register a new endpoint/route/feed/subdomain/CLI command/cron', the registry, @fluncle/registry, SURFACES, SurfaceWeight, the per-context weight matrix, surfacesForContext, the dev-row, or the surfaces doctrine. The agent how-to; docs/surfaces-doctrine.md is the human map. NOT for changing what a route DOES internally — this REGISTERS and ADVERTISES a surface so no consumer is forgotten."
---

# Fluncle surfaces — the add-a-surface runbook

A **surface** is any place Fluncle is reachable across the Galaxy: a web page on `www.fluncle.com`, a sibling subdomain (`galaxy.`, `radio.`, `found.`, `dig.`), a public `/api/v1` endpoint, a subscribable feed (RSS/Atom/JSON Feed/podcast/ICS), a machine-/crawler-facing discovery map (sitemap, robots, `llms.txt`, `.well-known/*`), the delegated DNS zone, the SSH rave terminal, the MCP server, a `fluncle` CLI command, or an on-box Hermes cron.

The job of this skill: when Fluncle gains a new surface (or one changes), **register it once and wire it everywhere it must show up so nothing is forgotten.** The companion human-facing map is [docs/surfaces-doctrine.md](../../docs/surfaces-doctrine.md); this is the agent-facing how-to.

## 1. The registry IS the single source of truth

Every surface is **one entry in `@fluncle/registry`** — the catalog in [`packages/registry/src/index.ts`](../../packages/registry/src/index.ts). It is **pure data**: a typed `SURFACES` array plus a handful of selectors. No I/O, no side effects, not a route table (the web app owns routing), not a secrets inventory (internal IPs, hostnames, op-paths, and credentials never go in it).

The point is **fan-out**: add a surface to the registry once and every consumer reads it from the same list instead of hand-maintaining a drifting copy.

### The `Surface` type

Each entry carries:

- **`name`** — a stable, unique id, dotted by family (`web.log`, `api.tracks`, `cli.recent`, `cron.enrich`). This is the catalog's primary key; consumers key off it. Name it per the cross-surface `verb_noun` convention ([docs/naming-conventions.md](../../docs/naming-conventions.md)).
- **`kind`** — the family: `web_route` | `subdomain` | `api` | `feed` | `discovery` | `dns` | `ssh` | `mcp` | `cli` | `cron`. Drives how a consumer renders/probes it.
- **`weights`** — the **per-context display matrix** (see §2). Sparse.
- **address** — exactly the field(s) the kind needs: `url`, `route` (a `www.fluncle.com` path), `subdomain` (a sibling host), `command` (a `cli`/`ssh`/`dns` shell invocation).
- **`exposedContent`** — a non-empty `string[]` saying what it serves, in plain words. Every consumer renders this as the human label.
- optional: **`apiFormat`** (the wire type an `api`/`feed`/`discovery` emits), **`probeConfig`** (how `/status` checks it — see §3 step 2), **`discoveryUrl`** (what advertises it), **`operatorNotes`** (tier, caveats, where the source lives — never secrets; the `/status` service id is mined from here via the `Probed on /status as service `<id>`` marker).

## 2. The per-context weight matrix

**Weight is per display context, not global.** A surface can be loud in one place and quiet (or absent) in another. The canonical example: the **Galaxy game is `primary` on the web homepage but `secondary` in the SSH terminal**; a CLI verb has no web presence at all.

```ts
weights: Partial<Record<SurfaceContext, SurfaceWeight>>;
```

- **`SurfaceContext`** = a surface that itself acts as a menu / nav / entry point ranking _other_ surfaces:
  - **`web`** — the homepage nav + dev-row (the browser front door).
  - **`ssh`** — the rave terminal menu (the keyboard front door).
  - **`cli`** — the `fluncle` CLI's own command surface (`--help` / about screen).
  - **`status`** — the `/status` health dashboard + the MCP `get_status` summary.
- **`SurfaceWeight`** = `primary` (leads that context) | `secondary` (advertised, not headline) | `tertiary` (low-level / infra) | `hidden` (registered but not advertised there — operator/agent-only).
- **Sparse:** an **absent context key means "not displayed there"**. A cron has no `web`/`ssh`/`cli` key; a CLI verb has no `web` key (except `cli.recent`, a tertiary nod that the CLI exists). Pick the weight by the surface's nature _in each context that shows it_.

Example entries:

```ts
{ name: "web.galaxy",  kind: "web_route", weights: { ssh: "secondary", web: "primary" },  /* … */ }
{ name: "cli.recent",  kind: "cli",       weights: { cli: "primary", web: "tertiary" },   /* … */ }
{ name: "cron.enrich", kind: "cron",      weights: { status: "hidden" },                  /* … */ }
```

Keep object keys **alphabetically sorted** (`oxfmt`/`sort-keys` enforces it): `ssh` before `web`, `cli` before `web`, `status` before `web`.

## 3. How the registry is CONSUMED (the fan-out)

When you add or change a surface, these are everywhere it shows up. The selectors live in `packages/registry/src/index.ts`:

- **`liveSurfaces()`** — the catalog minus `pending` (pre-staged, dark) surfaces. Every other selector reads through it, so a `pending` surface reaches no consumer (see step 4 of the runbook). A raw-catalog consumer should iterate this, not `SURFACES`.
- **`surfacesForContext(ctx)`** — surfaces displayed in `ctx`, sorted loudest-first. The per-context menu/nav builder.
- **`surfacesByWeight(ctx, weight)`** — one tier within a context.
- **`surfacesByKind(kind)`**, **`statusProbes()`** (probeConfig-bearing, type-narrowed), **`cronSurfaces()`**.

Real consumers — point at these when wiring:

| Consumer                     | File                                                                                                           | Reads                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/status` health board       | [`apps/web/src/routes/status.tsx`](../../apps/web/src/routes/status.tsx)                                       | `cronSurfaces()` for the cron order + labels                                                                                                                                                     |
| `/status` per-cron freshness | [`docs/agents/hermes/scripts/fluncle-healthcheck.ts`](../../docs/agents/hermes/scripts/fluncle-healthcheck.ts) | mirrors `cronSurfaces()` (the prober) — except `cron.healthcheck` itself, which it emits self-evidently (it IS the prober, run by a rave-02 host timer, so it has no gateway output dir to read) |
| MCP `get_status` tool        | [`apps/web/src/lib/server/mcp.ts`](../../apps/web/src/lib/server/mcp.ts)                                       | `liveSurfaces()` for the `/status` service labels                                                                                                                                                |
| CLI `status` command         | [`apps/cli/src/commands/status.ts`](../../apps/cli/src/commands/status.ts)                                     | `liveSurfaces()` for the service labels                                                                                                                                                          |
| Doctrine doc                 | [`docs/surfaces-doctrine.md`](../../docs/surfaces-doctrine.md)                                                 | the §2 kind tables + the §3 per-context matrix                                                                                                                                                   |
| Catalog invariants test      | [`packages/registry/src/index.test.ts`](../../packages/registry/src/index.test.ts)                             | unique names, kind-shaped fields, per-context partition                                                                                                                                          |

The homepage **dev-row / nav** weighting (`weights.web` via `surfacesForContext("web")`) and the SSH **menu** (`weights.ssh`) are the registry's intended consumers; when they read the registry, a new `web`/`ssh`-weighted surface joins those menus automatically. `llms.txt` and the sitemap (the crawler-/LLM-facing maps under `apps/web`) are the other public-web fan-out.

## 4. THE RUNBOOK — adding a new surface

1. **Add the registry entry.** Append one `Surface` to `SURFACES` in `packages/registry/src/index.ts`, in its `kind` group, keys alphabetical:
   - `name` (unique, `verb_noun` / dotted-family), `kind`, the address field(s) the kind needs (`url` / `route` / `subdomain` / `command`).
   - `exposedContent` (non-empty, plain words).
   - `weights` — a weight for **each context that should display it**; omit a context to leave it absent.
   - where they apply: `apiFormat`, `probeConfig`, `discoveryUrl`, `operatorNotes` (put the `service `<id>``marker here if`/status` probes it).
2. **Wire the fan-out checklist** — so no consumer is forgotten:
   - [ ] **`/status` probe** — add a `probeConfig` (`http` with `cadenceMs`/`timeoutMs`, or `cron` with `cronName`/`cadenceMs`). HTTP surfaces are GET-probed; crons are checked by last-run freshness. If it is a service id `/status` shows, write `Probed on /status as service `<id>``into`operatorNotes`and add the label in`status.tsx` (`SERVICE_LABELS`) + `SERVICE_ORDER`if it's a core service. A new cron needs a row in`fluncle-healthcheck.ts`'s on-box mirror.
   - [ ] **nav / dev-row** — give it `weights.web` so `surfacesForContext("web")` surfaces it on the homepage.
   - [ ] **SSH menu** — give it `weights.ssh` so the rave terminal lists it; wire the menu entry in `apps/ssh/main.go` (and a deep-link if it gets one).
   - [ ] **CLI help** — give it `weights.cli` if it is a `fluncle` verb.
   - [ ] **`llms.txt`** — a public web route / feed / discovery map flows into the LLM map (`apps/web`).
   - [ ] **sitemap** — a public page flows into [`apps/web/src/routes/sitemap[.]xml.ts`](../../apps/web/src/routes/sitemap[.]xml.ts).
   - [ ] **doctrine doc** — add the row to the matching §2 kind table (home-context weight) and to the §3 per-context matrix in `docs/surfaces-doctrine.md`.
   - [ ] **naming-conventions registry** — if it is a new public operation (CLI / API / MCP / SSH), run it past the "how to name a new feature" checklist in [docs/naming-conventions.md](../../docs/naming-conventions.md) before you fix the `name`.
3. **Operator/agent-only?** Give it only a `hidden` weight in the relevant context (e.g. `weights: { cli: "hidden" }` for `cli.admin`, or `weights: { status: "hidden" }` for a quiet cron). It stays registered + probeable without being advertised.
4. **Gated behind an external approval?** (a store review, a DNS cutover, anything not yet live). Add the entry now with **`pending: true`** — `liveSurfaces()` drops it, so it is reviewed but DARK everywhere (no menu, no `/status` probe, the dev-row, `llms.txt`, the sitemap, the §2/§3 tables). Fill in its real `weights`/`probeConfig` and a placeholder `url`, and capture the flip plan in `operatorNotes`. The day it goes live, the fan-out is **one field-flip**: drop `pending`, swap the placeholder address for the real one, and add its §2/§3 rows. `extension.lens` (the Fluncle Lens Chrome extension) used this flow while it was pending store approval; it has since shipped and dropped `pending`, so **no surface currently carries `pending: true`** — the flow stands ready with no live example.

## 5. Verify

From the repo root:

```bash
bun run --cwd packages/registry typecheck
bun packages/registry/src/index.test.ts   # self-running asserts; exits non-zero on failure
bunx oxfmt packages/registry/src/index.ts
bun run typecheck                          # all packages, if a consumer changed
```

The invariants test guards the catalog: unique `name`s, kind-shaped fields (a `cron` probeConfig only on a `cron` surface), and the per-context weight partition (within each context, the four weights cover exactly the surfaces displayed there, sorted loudest-first). If you broke one, the test names which.

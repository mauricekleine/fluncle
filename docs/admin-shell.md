# The admin shell

The contract for every `/admin` surface. `AdminShell` (`apps/web/src/components/admin/admin-shell.tsx`) is the one workspace chrome: the sidebar (`admin-sidebar.tsx`, the only navigation surface) plus a full-viewport content plate with a fixed header grammar. Every guarded admin page composes it; login stays a bare centered card outside it.

## The placement contract

One home per kind of control. Put each control in its slot and nowhere else.

- **Page-level actions** go in the header slot, top-right (`headerActions`). One primary action per page keeps the One Sun budget (DESIGN.md).
- **Row actions** live inline on the row, right-aligned.
- **Bulk actions** live in a selection bar that appears with the selection and names its scope (`3 selected`).
- **Destructive actions** sit behind a confirm (`AlertDialog` from `@fluncle/ui`) that names the object it destroys.
- **A new page** gets exactly one sidebar entry, placed with its object group in `admin-sidebar.tsx`. The page declares that entry as its `current` owner key.
- **Filters and view state** live in the `subheader` strip and deep-link through search params, so every view survives reload and pasteable URLs stay the operator's bookmarks.
- **Per-operator display preferences** live behind the sidebar's Display settings cog.

## The nav model

The sidebar is a flat object nav: Dashboard, then the objects in pipeline order (Findings, Plans, Recordings, Mixtapes, Clips, Newsletter), then System. Dashboard owns `/admin` — the attention queue (docs/cockpit-roadmap.md "The queue"): every action the system needs as a row, zero rows the success state, snooze/won't-do persisted client-side (one operator, one browser — a localStorage map, since a server column could not see this browser's working set). Findings owns `/admin/findings`, the pipeline board (the queue's deep-link target for the publish loop; the board's `?stage`/`?mix` deep-links survive — old `/admin?stage=…` links redirect). An entry whose station doesn't exist yet points at the best current home for that object and stays unlit there; it lights only on the page that declares it as owner. Count badges carry live, cheap, honest server counts (a scoped `COUNT` per number); a number that can only be estimated stays off the rail.

## Auth

One identity, two carriers: the CLI and agents send `FLUNCLE_API_TOKEN` as a `Bearer` header; the browser carries a signed grant cookie (`{ role: "admin", iat }`, HMAC'd with `ADMIN_SESSION_SECRET` via `signState` in `env.ts` — the key never reaches the client). `requireAdmin` accepts either. The browser proves identity with **Login with Spotify**, allow-listed to the operator through `ADMIN_ALLOWED_EMAILS` (+ optional `ADMIN_ALLOWED_SPOTIFY_IDS`) in `admin-auth.ts`; the login exchanges the code only to read the profile and discards the tokens — it never touches the publish refresh token in `spotify_auth`. On success it sets the grant cookie (`Path=/`, 30-day window) and redirects to `/admin`. Login at `/admin/login`, sign out at `/api/admin/logout`; the gate is active in dev too (just without `Secure` on localhost).

## The chrome gate

- Admin UI ships through the impeccable flow (`shape` → build → `audit`) and honors DESIGN.md, PRODUCT.md, and VOICE.md.
- Chrome is actions, data, and artwork (docs/cockpit-roadmap.md, the design doctrine). Every element is an action, a datum, or cover art.
- Components come from `@fluncle/ui` Shadcn exports. A missing component is added with `bunx --bun shadcn@latest add <component>` inside `packages/ui`, then aligned with the canon tokens.
- Interface icons come from Phosphor (regular idle, fill active); platform marks from `simple-icons` via `BrandIcon`.
- WCAG AA contrast, keyboard reach for every control, and reduced-motion fallbacks are part of done.

## Verifying

Browser-verification fixtures live in `apps/web/tests/browser/` (playwright-core driving the system Chrome). Every UI agent verifying `/admin` uses them:

- `admin.ts` — `loginAsAdmin(page, baseUrl)` mints the real admin grant through the production signing path (`signGrant` → HMAC with `ADMIN_SESSION_SECRET` from `apps/web/.dev.vars`) and sets the grant cookie; `launchBrowser()` + `newAdminPage()` wrap the launch/viewport/cookie boilerplate.
- `shell-smoke.ts` — clicks through every sidebar entry as the operator, past hydration (it proves interactivity by toggling the sidebar, retrying until a click sticks), at desktop and phone widths, screenshots each stop, and fails on any console or page error:

```bash
BASE_URL=http://127.0.0.1:3000 OUT_DIR=/tmp/shell-smoke bun tests/browser/shell-smoke.ts
```

- `queue-smoke.ts` — drives the `/admin` attention queue end-to-end (the j/k+Enter loop past hydration, a caption copy into the real clipboard, snooze, won't-do + Undo, [Show all], draining to the zero state, and the legacy `?stage`/`?mix` redirect to `/admin/findings`), desktop + phone, screenshots each stop. `SEED=1` self-seeds the local dev DB with rows for every queue source around the run (removed in a `finally`; it refuses a non-local database URL):

```bash
BASE_URL=http://127.0.0.1:3000 OUT_DIR=/tmp/queue-smoke SEED=1 bun tests/browser/queue-smoke.ts
```

Run them against a live dev server (per [docs/local-database.md](./local-database.md); in a worktree, copy main's `.dev.vars` and run `bun run --cwd apps/web dev:vite`). Read the screenshots after every shell or admin-chrome change.

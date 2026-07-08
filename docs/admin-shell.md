# The admin shell

The contract for every `/admin` surface. The workspace chrome splits across two levels so it stays mounted as the operator moves between stations. The **persistent shell** — the sidebar (`admin-sidebar.tsx`, the only navigation surface, with its live count query) and the full-viewport content plate (the translucent glass pane over the cosmos) — is mounted **once** in the `/admin` layout route (`apps/web/src/routes/admin/route.tsx`), wrapping the `Outlet`. It never re-mounts on navigation, so the sidebar's count badges never blink out and refetch and the plate's backdrop-blur never re-composites (no background flash). Each guarded page renders only its **header + body** through `AdminShell` (`apps/web/src/components/admin/admin-shell.tsx`) — the fixed header grammar (sidebar trigger, title + optional subtitle, the `headerActions` slot) plus an optional `subheader` and the page body. Login stays a bare centered card outside the shell (the layout bypasses it by path). The layout also owns the two cross-page structural bits the page can't set on a shared frame: it lights the active sidebar entry from the URL (`navKeyForPath`), and it switches the one viewport-height, self-scrolling station (the Studio) into fill mode by path.

## The placement contract

One home per kind of control. Put each control in its slot and nowhere else.

- **Page-level actions** go in the header slot, top-right (`headerActions`). One primary action per page keeps the One Sun budget (DESIGN.md).
- **Row actions** live inline on the row, right-aligned.
- **Bulk actions** live in a selection bar that appears with the selection and names its scope (`3 selected`).
- **Destructive actions** sit behind a confirm (`AlertDialog` from `@fluncle/ui`) that names the object it destroys.
- **A new page** gets exactly one sidebar entry, placed with its object group in `admin-sidebar.tsx`, and its route registered in `navKeyForPath` so the persistent sidebar lights the right entry from the URL (a page with no entry of its own — the Studio — maps to its parent object's entry).
- **Filters and view state** live in the `subheader` strip and deep-link through search params, so every view survives reload and pasteable URLs stay the operator's bookmarks.
- **Per-operator display preferences** live behind the sidebar's Display settings cog.

**The disclosure law — one primary per object, everything rare hidden by default.** When the operator lands on a page, the one thing they came to do is the loudest element and reads at a glance; nothing competes with it. Every infrequent or destructive action is demoted off the resting surface — behind a `⋮` menu (Phosphor `DotsThreeVertical`, `DropdownMenu` from `@fluncle/ui`), a hover card, an expand, or a dialog. Never surface two ways to do the same thing, and never let a control the operator uses once a week sit at the same weight as the one they use every visit. Progressive disclosure over density: show what's needed now, reveal the rest on intent. This is why the Renders row's cover IS the play button (no second Watch control) with Requeue/Purge in a `⋮`, why the Artists page collapses to summary rows with add/remove behind a dialog, and why a clip's TikTok and YouTube legs are separate one-action rows instead of one stuffed panel.

## The Object Row

Every index page — a page whose job is "see the objects, open one" (Renders, Mixtapes, Recordings, Playlists, Artists) — presents its objects through one shared primitive, `object-row.tsx` (`ObjectList` + `ObjectRow` + `ObjectLead` + `ObjectGlyph`), so a row reads and behaves the same wherever it lands: a bordered, divide-y list; each row a leading visual (a cover, or an `ObjectGlyph` fallback at the shared `size-11` footprint), an identity that grows, then a right-aligned zone for the object's quiet meta and its one primary action, with anything rare in a `⋮`. Track-shaped rows feed `FindingIdentity` as the lead (its `plate` cover doubles as the play button when the object has a clip); set-shaped rows use `ObjectLead`. An **editor** page (Playlists, Studio) is an accordion/builder by nature — its collapsed summary row still matches the Object Row look, but expanding reveals the editor, not a detail view. Do not reach for a card grid or a bespoke list; extend the primitive.

Per page, the primary goal decides the layout — what's loud, what's hidden:

| Page                              | Primary goal (what you came to do)      | Primary action                    | Infrequent → hidden behind                              |
| --------------------------------- | --------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| Dashboard                         | Clear the next actionable step          | the row's one inline action / `↵` | snooze, won't-do (icon + tooltip)                       |
| Findings                          | Scan pipeline state; preview a finding  | cover = play; scan the columns    | run-a-step, R2, silent clip (`⋮`); socials (hover card) |
| Renders                           | Watch the fresh render                  | cover = play                      | requeue, purge (`⋮` → confirm)                          |
| Artists                           | Confirm/follow the links needing a look | Confirm / Follow / Mark done      | add, remove, edit a platform (Manage-links dialog)      |
| Mixtapes / Recordings / Playlists | See the objects; open one               | open the object                   | create/upload (header); dist links                      |

## The nav model

The sidebar is a flat object nav: Dashboard, then the objects in pipeline order (Findings, Plans, Recordings, Mixtapes, Clips, Newsletter), then an "Ops" group (the Costs station and the Usage & cost station), then System. The Ops group pairs COST-02 and COST-01: **Costs** (`/admin/costs`) is the operator's private subscriptions ledger (recurring + one-off spend, entered by hand), and **Usage & cost** (`/admin/usage`) is COST-01's read on what the pipeline SPENDS per automation step and per finding, aggregated from the append-only `cost_events` ledger (docs/track-lifecycle.md). The two share only the operator's mental model, never data or a combined total: `/admin/usage` renders CASH (real incremental money — the headline) and SUBSIDIZED draw (fixed-plan usage — subscription LLM tokens + on-box compute) in SEPARATE columns, never summed, with unpriced rows counted rather than laundered to $0. Neither Ops entry carries a count badge (aggregates aren't cheap honest counts). Dashboard owns `/admin` — the attention queue (docs/planning/cockpit-roadmap.md "The queue"): every action the system needs as a row, zero rows the success state, snooze/won't-do persisted client-side (one operator, one browser — a localStorage map, since a server column could not see this browser's working set). Findings owns `/admin/findings`, the pipeline board (the queue's deep-link target for the publish loop; the board's `?stage`/`?mix` deep-links survive — old `/admin?stage=…` links redirect). An entry whose station doesn't exist yet points at the best current home for that object and stays unlit there; it lights only on the page that declares it as owner. Count badges carry live, cheap, honest server counts (a scoped `COUNT` per number); a number that can only be estimated stays off the rail.

## Auth

One identity, two carriers: the CLI and agents send `FLUNCLE_API_TOKEN` as a `Bearer` header; the browser carries a signed grant cookie (`{ role: "admin", iat }`, HMAC'd with `ADMIN_SESSION_SECRET` via `signState` in `env.ts` — the key never reaches the client). `requireAdmin` accepts either. The browser proves identity with **Login with Spotify**, allow-listed to the operator through `ADMIN_ALLOWED_EMAILS` (+ optional `ADMIN_ALLOWED_SPOTIFY_IDS`) in `admin-auth.ts`; the login exchanges the code only to read the profile and discards the tokens — it never touches the publish refresh token in `spotify_auth`. On success it sets the grant cookie (`Path=/`, 30-day window) and redirects to `/admin`. Login at `/admin/login`, sign out at `/api/admin/logout`; the gate is active in dev too (just without `Secure` on localhost).

## The chrome gate

- Admin UI ships through the impeccable flow (`shape` → build → `audit`) and honors DESIGN.md, PRODUCT.md, and VOICE.md.
- Chrome is actions, data, and artwork (docs/planning/cockpit-roadmap.md, the design doctrine). Every element is an action, a datum, or cover art.
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

- `admin-touch-smoke.ts` — pins the touch-comfortable-admin contract (DIST-02): on a coarse-pointer touch context (iPhone viewport, `hasTouch` + `isMobile`) every button-control on every admin surface is ≥44px and no surface bleeds horizontally, while on a fine-pointer mouse context the same controls stay their dense sub-44px selves — proving the 44px floor (`styles.css`, scoped to `.admin-workspace`) is touch-only and never bloats the desktop UI:

```bash
BASE_URL=http://127.0.0.1:3000 bun tests/browser/admin-touch-smoke.ts
```

- `admin-subscriptions-smoke.ts` — pins the Costs station CRUD (COST-02): drives the `/admin/costs` dialog end-to-end (add a throwaway line → edit its amount → delete it through the confirm), asserting each mutation reflects in the ledger. It proves the whole operator-tier write path — the admin cookie satisfying `operatorGuard` on `create/update/delete_subscription`, the server validation, the list refetch — and is self-cleaning, so a failed run leaves at most one clearly-named row in the local dev DB:

```bash
BASE_URL=http://127.0.0.1:3000 bun tests/browser/admin-subscriptions-smoke.ts
```

Run them against a live dev server (per [docs/local-database.md](./local-database.md); in a worktree, copy main's `.dev.vars` and run `bun run --cwd apps/web dev:vite`). Read the screenshots after every shell or admin-chrome change.

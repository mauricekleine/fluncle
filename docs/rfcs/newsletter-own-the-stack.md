# RFC: Own the newsletter stack — a `/newsletter` archive, and move the send to Resend

**Status:** Locked & execution-ready (decisions resolved 2026-06-21; built on the prior research → Context7 vendor verification → code-grounding pass). **Scope is A + B, confirmed:** ship the archive AND move the send off Loops to **Resend**. **Sequenced AFTER the oRPC migration** — the newsletter API is built _on_ the new oRPC contracts with Convention B names, so it follows the oRPC slice (`docs/orpc-migration-brief.md`, the sole active slice) and does not race it. **Target: next Friday's edition** (drafted on a Sunday; one build week, A+B together, with the Friday send as the live proof). **Identity reworked:** an edition is its **own object with a sequential `/newsletter/<id>` URL** — **not** a Log ID, **not** a Galaxy star (see §2.2 for the reasoning; this is the big change from the prior draft).
**For:** the build session that stands up the editions table + the `/newsletter` archive + the Resend send, on the oRPC rails. Maurice owns the already-approved external steps (Resend account, DNS, the 4-contact Loops export).
**Canon/authority:** the codebase and `AGENTS.md` arbitrate; `docs/track-lifecycle.md`, `docs/naming-conventions.md` (Convention B — **ratified**), the mixtape spine model (`packages/skills/fluncle-mixtapes/references/spine-model.md` — the precedent this RFC partly **rejects**), `docs/agents/newsletter-agent.md`, `VOICE.md` / `packages/skills/copywriting-fluncle`, and the live `fluncle` CLI + `/api/v1` are ground truth. This is planning under `docs/`, not spec.

> Process note: this revision bakes in Maurice's locked decisions and reworks everything they invalidate. The single largest change is **dropping the Log-ID / spine-via-Log-ID identity model** the prior draft inherited from the mixtape precedent. A Log ID is reserved for **collectible media — the stars you collect in the Galaxy games**; a newsletter edition is content, not a collectible, so giving it a coordinate is awkward and a second Log-ID namespace is confusing. An edition is its own object with its own readable URL (`/newsletter/1`, `/newsletter/2`, …). The mixtape stays the precedent for the _fan-out shape_ (its own table + counter, a universal index, RSS/JSON-LD/llms.txt inclusion) but **not** for identity. The API follows Convention B exactly — this RFC is the live first test of the convention on a new feature.

---

## The standard (definition of done)

This RFC describes one complete delivery, **A + B together** — not a menu, not a floor-plus-stretch. When it is built:

- **Both problems are closed by one data model.** The archive exists (every edition is readable on `fluncle.com` forever at `/newsletter/<id>`), and the Friday send is no longer a manual Loops dashboard tap — the agent persists the edition payload and creates + sends a Resend broadcast. One persisted edition solves both.
- **The edition is a real, self-contained object — its own URL, not a coordinate.** A sequential edition number, a `/newsletter/<id>` page, a `/newsletter` index, RSS + JSON-LD (`BlogPosting`) + sitemap + an llms.txt section. **No Log ID, no `/log/<id>` branch, no `resolveLogPageTarget` arm, not a Galaxy star, not a collectible in the feed.** Sourced from the content the agent already authors, persisted at draft time, rendered into **both** the web archive page and the email HTML from one stored JSON payload.
- **Tests + docs are part of done.** New server code (the `editions` table + the sequential mint, the oRPC contracts + handlers, the public reads, the admin create/send, the RSS/sitemap inclusion, the subscribe-move) ships with unit tests in `apps/web` (+ `apps/cli` for the new command), mirroring the mixtape test shape (`mixtape-log-id.test.ts` is the structural model even though the mint math is simpler here). `docs/agents/newsletter-agent.md` is rewritten to the Resend flow; the spine model gets a short "editions are NOT on the spine" note; the PRODUCT.md object line lands.
- **The only sanctioned external dependency** is owner-run: the Resend account + DNS verification, and the 4-contact Loops export. All **approved** (External Effects) — these are owner-run steps, not deferrals, and they're trivially small (§5).

A note on altitude: this is a small, slow surface (one edition a week, a hobby D&B list of **4 subscribers** who have received exactly **1 edition**). The archive half is cheap and high-value (it makes a whole class of Fluncle's writing permanent and crawlable). The send-migration half is a real provider swap, but at this scale the "migration" is a five-minute hand-move, not a project (§5). Both ship together because the same persisted edition powers both.

---

## 0. Summary / the reframe

**The unifying simplification: we persist editions either way, so persistence is the spine — and once editions live in our DB, the send provider is a swappable detail.** We swap it now (to Resend), in the same build.

- **Problem 1 — no archive.** Past editions live only in Loops: sent, then gone. There is no way to read a previous Friday letter anywhere on `fluncle.com`. The newsletter is the one Fluncle writing surface with no permanent home.
- **Problem 2 — Loops blocks auto-send.** The Friday agent (`docs/agents/newsletter-agent.md`) authors the whole edition, then can only **stage** a Loops campaign — Loops has no programmatic campaign-send (CLI/SDK/API/docs all confirm; dashboard-only), so the weekly send is a manual operator tap. Verified still true. This is the one weekly-cadence manual step in an otherwise automated pipeline.
- **Why they're solved together.** The archive forces us to persist each edition's content in our own DB. Once it's persisted, keeping Loops _only to send_ is the odd part: paying a managed sender to do the one thing (send a stored payload to a list) that a send-API provider does in one HTTP call — while _also_ owning the content. Resend has a real broadcast API; the list is 4 people. So we move the send in the same build.
- **The precedent we follow — and the part we reject.** A **mixtape** is the model for the _fan-out shape_: a non-track object with its own table + counter, a dedicated index, quiet RSS inclusion as a distinct item type, its own JSON-LD, an llms.txt section. We follow that shape. We **reject** the mixtape's _identity_ model: a mixtape has an `F`-marked Log ID and a `/log/<id>` page because a mixtape is collectible Fluncle media. **An edition is not.** See §2.2 — the edition gets its own object URL (`/newsletter/<id>`), no coordinate.
- **The provider answer (settled).** Of the honest options, **Resend** is the only candidate that closes the auto-send gap _and_ keeps a managed sender's deliverability + compliance, with a Workers-native API:
  - **Resend (chosen).** Real broadcast API: create + send a broadcast to an audience over HTTP, managed unsubscribe (`{{{RESEND_UNSUBSCRIBE_URL}}}`) with automatic RFC-8058 one-click `List-Unsubscribe`, CSV contact import, Workers-native sending, bounce/complaint webhooks. Closes Problem 2.
  - **Cloudflare Email Service (rejected).** Transactional-only by its own FAQ — no audiences, no broadcast, no managed unsubscribe. Running the newsletter on it means rolling our own ESP (subscriber table, suppression, unsubscribe endpoint, per-recipient loop) for a 4-person list. Not until Cloudflare ships bulk tooling.
  - **Keep-Loops-to-send (rejected as the end state).** It leaves Problem 2 open. With a 4-contact list there is no reason to keep a second managed sender purely to press a button.

---

## 1. Context & goals

**Why now.** The ROADMAP carries the seed ("Newsletter archive — bring the editions home"). The mixtape shipped the spine-native fan-out pattern, so the archive is a follow-the-shape job. The auto-send gap is real, recurring friction: every Friday the agent does 100% of the authoring and a human opens the Loops dashboard and presses Send. Persisting editions for the archive is the natural moment to move the send too — and with a 4-person list, the move is cheap.

**Sequencing (locked).** This work is **sequenced after the oRPC migration** (`docs/orpc-migration-brief.md`), which is the sole active slice and must run alone. The newsletter API is built **on the oRPC contracts** with Convention B `verb_noun` names — so the editions reads, the admin create/send, and the subscribe-move are all new oRPC contracts in `packages/contracts/orpc`, generating their own OpenAPI operations. Building before oRPC lands would mean writing hand-maintained routes we'd immediately rewrite; building after means the newsletter is the first _new feature_ to exercise Convention B end to end (§3).

**Goals:**

- Every edition persists to our DB at draft time and gets a permanent, crawlable `/newsletter/<id>` home + a `/newsletter` index, rendered from the same source as the email. Closes Problem 1.
- The Friday send becomes a programmatic Resend broadcast — no dashboard tap. Closes Problem 2.
- **Non-goals:** building our own ESP on Cloudflare transactional sends; a visual drag-and-drop email builder (the LMX template + the stored payload are the source); per-subscriber personalization beyond a first-name token; double-opt-in changes (today's single-opt-in + confirmation courtesy is kept); analytics dashboards; **any Log ID / coordinate / Galaxy-star treatment for editions** (explicitly out — §2.2).

**Canon / PRODUCT fit.** The newsletter is canon: **"the mothership"** — "the newsletter and its list. You board it by subscribing… it departs every Friday" (voice canon). The **Email register** already exists in VOICE.md §5 ("A letter from the uncle to the crew… Opens 'Ahoy cosmonauts,' closes 'Happy raving, Fluncle'"). No new register is needed — the edition is written in the register that already governs the email. The new thing is that the letter now _persists_ as a readable back-issue on `fluncle.com`. It is **not** a collectible; it does not get a coordinate (that distinction is the §2.2 reasoning). Publishing stays operator-controllable: the agent drafts and creates the broadcast; an explicit send step (§4.2) keeps the human gate the dashboard tap used to provide.

---

## 2. The editions object (the archive)

The edition becomes a first-class object with its own table, its own sequential identity, and its own URL. It borrows the mixtape's _fan-out shape_ but not its identity.

### 2.1 The object: an edition is not a finding, a mixtape, or a collectible

A finding is one banger. A mixtape is a consolidation of findings (Fluncle dreaming) — **collectible Fluncle media**. An **edition** is a weekly dispatch — a letter to the crew naming the week's finds. The differences are load-bearing:

- An edition is **not a "find"** — it does **not** increment the `FOUND · N` counter (the feed-count is findings-only, verified in `feedFindingsCount`).
- It is **not** a track (no ISRC, no BPM/key chip row) and **not** a mixtape (no Mixcloud/YouTube distribution, no member-track audio, **no Log ID**).
- It is **content, not a collectible.** It _references_ findings (the week's tracks) but a track can appear in many editions, so membership is a soft reference list, not a frozen tracklist.

### 2.2 Identity — a sequential edition number, NOT a Log ID (the big rework)

**Decision (locked): editions do not get Log IDs.** The prior draft proposed an `N`-marked Log ID (`019.N.001`) and a `/log/<id>` page, modeled on the mixtape `F`. That is **rejected**, for a concrete reason worth recording:

> A **Log ID is reserved for real, collectible media — the stars you collect in the Galaxy games.** Findings and mixtapes are things a crew member _collects_; a coordinate is what a collectible carries. A newsletter edition is a letter — content, not a collectible. Giving it a coordinate is awkward (a letter isn't a star you found at a sector), and standing up a **second, separate Log-ID namespace** (the `N` marker, its own pattern, its own resolver branch) is confusing: it dilutes what a Log ID _means_. There is no lore reason strong enough to justify it here — so Log IDs stay reserved for collectible media, and an edition is simply its own object.

**The chosen identity: a sequential edition number with a readable URL.**

- The edition is its own object at **`/newsletter/<id>`** — `/newsletter/1`, `/newsletter/2`, …, the index at `/newsletter`.
- The number is a **simple integer counter**: an `editions` table with a `number` column minted on send (`max(number) + 1`). No Log ID column, no sector math, no marker letter, no `<digit><letter>` tail, no cap-54 problem (a plain integer never exhausts).
- **Not on the spine:** no `resolveLogPageTarget` branch, no `isEditionLogId` pattern, no `/log/<id>` arm. The universal Log resolver is untouched. An edition is reached only at `/newsletter/<id>`.
- **Not a Galaxy star, not a feed collectible.** Editions do not appear as collectible rows in the main `/api/tracks` feed (the feed is findings + the occasional mixtape). The archive is its own surface.

**Alternative considered (noted, not chosen): a date-slug URL** (`/newsletter/2026-06-26`). A date slug is human-readable and stable, but a sequential number is what the voice already uses ("Edition No. 1"), reads cleaner in copy and in the subject line, and a small archive benefits from an obvious ordinal. **A sequential number is chosen; the date-slug stays the fallback** if a collision-free human slug is ever wanted (the `sentAt` date is stored regardless, so a slug route could be added later without a schema change).

### 2.3 The data model — an `editions` table

Following the `mixtapes` table _shape_ (its own table, its own counter, a draft→sent lifecycle) — but the identity column is a plain integer `number`, not a `logId`. The stored **content payload is the single source** that renders both the web page and the email HTML.

```ts
// apps/web/src/db/schema.ts — a new table, modeled on `mixtapes` shape, no Log ID
export const editions = sqliteTable("editions", {
  id: text("id").primaryKey(),
  number: integer("number").unique(), // the sequential edition number — minted on send, null while draft
  status: text("status", { enum: ["draft", "sent"] })
    .notNull()
    .default("draft"),
  subject: text("subject"), // the email subject line
  // The single source of truth for BOTH renders. A structured JSON payload the
  // agent authors (intro, the galaxy-grouped track refs by logId, the mixtape
  // ref if any, the tidbits with sources) — NOT raw LMX. The web archive page and
  // the email HTML are both rendered FROM this. Stored as JSON text.
  contentJson: text("content_json").notNull(),
  windowSince: text("window_since"), // the discovery window this edition covered
  windowUntil: text("window_until"),
  // Provenance of the send: the Resend broadcast id, so a re-send is idempotent
  // and the archive records how it went out.
  sendProvider: text("send_provider"), // "resend"
  sendExternalId: text("send_external_id"), // Resend broadcast id
  sentAt: text("sent_at"),
  addedAt: text("added_at"), // RSS/index ordering — set on send
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

- **Why a JSON content payload, not stored LMX/HTML:** the archive page is a web-register page on `fluncle.com`, _not_ an email rendered in a browser. Storing the _structured_ edition (intro text, ordered track references by `logId`, the optional mixtape reference, the tidbits) lets us render two presentations — the email HTML (the LMX template, filled) and the web archive page (the site's components) — from one source. This is the load-bearing "one source → both renders" requirement. Storing raw LMX would couple the archive to email markup; storing track _references by logId_ (not denormalized copies) keeps the archive live (a finding's title/cover updates if it changes) and tiny.
- **Track references, not frozen copies:** the payload stores each finding's `logId` + the agent's per-track "why" line (the editorial sentence written _for this edition_, which may differ from the finding's own `note`). The archive page hydrates the live finding from `tracks` by `logId` (cover, title, artists) and overlays the edition's "why." (A finding's own Log ID is how it's referenced — that's a collectible; the edition that references it is not.)
- **No subscriber data in this table.** Editions are content; the list is Resend's concern (§4.1).

**Generate the migration** (never hand-write SQL — `AGENTS.md`): `bun run --cwd apps/web db:generate`, committed with its metadata. It applies automatically in the Cloudflare build (`deploy:cf` → `db:migrate`).

### 2.4 The route — `/newsletter/<id>` (its own page, no resolver branch)

There is **no** universal-resolver change. The edition gets a dedicated TanStack route:

```ts
// apps/web/src/routes/newsletter.$id.tsx — the edition archive page (sent editions only)
// Loads the edition by its integer number, hydrates referenced findings from `tracks`
// by logId, renders the web-register presentation of the stored contentJson:
//   - the subject as the nameplate
//   - the intro
//   - the galaxy-grouped finding links (each → /log/<finding-id>, the finding's own page)
//   - the mixtape link if present (→ /log/<mixtape-id>)
//   - the tidbits with sources
// It is the same CONTENT the email carries, rendered in the web register.
// No coordinate decode — an edition has no coordinate.
```

The `/newsletter` index (`apps/web/src/routes/newsletter.index.tsx`) lists sent editions newest-first, modeled on `mixtapes.index.tsx` (the layout precedent; the data is editions, not mixtapes). The `/log/$logId.tsx` route and `resolveLogPageTarget` are **untouched** — an edition never resolves there.

### 2.5 The fan-out (build map) — the mixtape's _shape_, the edition's _identity_

| Surface   | A mixtape does (Log-ID / collectible)                  | An edition does (own object, `/newsletter/<id>`)                                                                                                           |
| --------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page      | `/log/<F-coord>` compilation page                      | **`/newsletter/<id>`**: subject, intro, the week's findings (galaxy-grouped, each linked to its `/log` page), the mixtape ref, tidbits — **no coordinate** |
| Web index | `/mixtapes`                                            | a dedicated **`/newsletter`** archive (newest first), modeled on `mixtapes.index.tsx`                                                                      |
| Web feed  | quiet checkpoint row (collectible)                     | **not in the feed** — an edition is content, not a collectible (locked; §2.2)                                                                              |
| API       | `/api/v1/mixtapes`, mixtape-typed in `/api/tracks/:id` | **oRPC contracts (Convention B):** `list_editions` (`GET /editions`), `get_edition` (`GET /editions/{number}`) — §3                                        |
| RSS       | UNION arm + `<category>mixtape</category>`             | a third UNION arm + `<category…>edition</category>`, linking `/newsletter/<id>`                                                                            |
| JSON-LD   | `MusicAlbum` / `DJMixAlbum`                            | **`BlogPosting`** at `/newsletter/<id>`: `datePublished` = sentAt, `author` = Fluncle, `about` referencing the findings — **not** a `/log` object          |
| Sitemap   | `/log/<coord>` entries                                 | `/newsletter` + each `/newsletter/<id>` (sent only)                                                                                                        |
| llms.txt  | a Mixtapes section                                     | a **Newsletter / Editions** section: "Fluncle's weekly dispatch; each edition is a back-issue at `/newsletter/<id>`; not a collectible, no coordinate."    |
| CLI       | `fluncle mixtapes`                                     | `fluncle newsletter` (list editions) — thin, optional follow-on                                                                                            |

### 2.6 One source → two renders (the load-bearing rule, preserved)

The stored `contentJson` is rendered twice:

1. **Email HTML** — the existing `docs/agents/newsletter-template.lmx` template, filled from the payload, becomes the Resend broadcast's HTML body.
2. **Web archive page** — `/newsletter/<id>` renders the payload through the site's components (the web register), not the email markup.

The agent authors _once_ (the structured payload), persists it, and both renders derive from it. This is the answer to "rendered as both the web archive page and the email HTML from one source," and it is **preserved exactly** through the identity rework.

---

## 3. The API — Convention B, end to end (the live first test)

This is the first new feature built on the ratified Convention B (`docs/naming-conventions.md`) and the oRPC contract rails (`docs/orpc-migration-brief.md`). Every endpoint is a `verb_noun` canonical op with a fixed projection to each surface. The naming-conventions checklist (its §6) is applied literally.

### 3.1 The subscribe move (resolves the collision)

**Decision (locked): move the subscribe POST off `/api/newsletter`.** Today `subscribeToNewsletter()` is served at `POST /api/newsletter` + `POST /api/v1/newsletter` (operationId `subscribeNewsletter`). The archive wants `/newsletter` for the human page and `/editions` for the object reads. The collision is resolved by **moving subscribe to a named action sub-resource: `POST /newsletter/subscribe`.**

- `/editions` for the subscribe path was **rejected** — too generic, and it collides conceptually with "mixtape edition." "Subscribe" is an action on the newsletter, so it belongs under `newsletter`, not under the object collection.
- Per Convention B, a non-CRUD action is `POST /{resource}/{action}` with a single-word action: **`POST /newsletter/subscribe`**. The canonical op stays `subscribe_newsletter`; only the path moves.
- The bare `/api/newsletter` path is kept as a **permanent back-compat alias** (the existing `-alias.ts` plumbing) so the current web form / CLI `subscribe` / MCP `subscribe_newsletter` / WebMCP keep working through the cutover; the canonical contract serves `/api/v1/newsletter/subscribe`.

### 3.2 The contract registry (Convention B projections)

Every operation, named once as `verb_noun`, projected per the convention:

| Canonical op           | API (REST, method + path)                         | operationId           | MCP / WebMCP tool      | CLI                                                 |
| ---------------------- | ------------------------------------------------- | --------------------- | ---------------------- | --------------------------------------------------- |
| `list_editions`        | `GET /editions` (sent-only)                       | `listEditions`        | `list_editions` (opt.) | `fluncle newsletter` (root, voice alias)            |
| `get_edition`          | `GET /editions/{number}`                          | `getEdition`          | `get_edition` (opt.)   | (resolved via `newsletter`)                         |
| `subscribe_newsletter` | `POST /newsletter/subscribe` (moved; alias kept)  | `subscribeNewsletter` | `subscribe_newsletter` | `subscribe` (root, voice alias — unchanged surface) |
| `create_edition`       | `POST /admin/editions` (draft)                    | `createEdition`       | — (admin, not public)  | `admin newsletter draft`                            |
| `update_edition`       | `PATCH /admin/editions/{id}` (edit draft)         | `updateEdition`       | — (admin)              | `admin newsletter update`                           |
| `send_edition`         | `POST /admin/editions/{id}/send` (broadcast+mint) | `sendEdition`         | — (admin)              | `admin newsletter send`                             |

Notes that make this convention-correct:

- **`verb_noun` → camelCase operationId** is mechanical (`list_editions` ⇒ `listEditions`), and each public read is a contract in `packages/contracts/orpc`, so the OpenAPI operation is generated, not hand-named — exactly the oRPC-brief coverage rule (a public route without a contract is a build failure).
- **Plural resource collection** (`/editions`), **singular machine noun** in the op (`edition`) — per the convention's pluralization rule (collections plural; op nouns singular).
- **The send is a named action sub-resource** (`POST /admin/editions/{id}/send`), single-word action `send`, no dash-compound — matching the mixtape `…/publish` shape and the convention's "no multi-word path segments" rule.
- **Public reads are `/api/v1/editions`** (canonical) with the `/api/editions` alias via `-alias.ts`. Admin reads/writes (`/admin/editions*`) stay **off the public OpenAPI spec**, cookie-or-bearer gated (`requireOperator`/`requireAdmin`), exactly like the mixtape admin routes — admin is intentionally not oRPC-contract-public per the oRPC brief, but the public `list_editions` / `get_edition` / `subscribe_newsletter` ops _are_ contracts.
- **MCP tools for the reads are optional follow-ons** (`list_editions`, `get_edition`) — the archive's primary consumers are humans + crawlers; the reads are listed in the registry so the names are reserved and derivable, but wiring the MCP tools is a thin optional step, not a ship gate.
- **CLI:** the public read is the voice-register root command `fluncle newsletter` (a registered alias of `list_editions`, like `recent → list_tracks`); the admin commands are `admin newsletter draft|update|send` under the plural-group admin tree (`admin newsletter`), mirroring `admin mixtapes …`.

### 3.3 The admin endpoints (modeled on the mixtape admin routes)

- `POST /admin/editions` → `createEdition(payload)` (`requireOperator`/`requireAdmin`) — mirrors `POST /admin/mixtapes`. Creates a **draft** (no number yet).
- `PATCH /admin/editions/{id}` → `updateEdition` — edit the payload/subject before send.
- `POST /admin/editions/{id}/send` → `sendEdition`: render the email HTML from `contentJson`, create the Resend broadcast, send it (per the §4.2 guardrail), and on success **mint the sequential `number`** (`max(number)+1`, atomic), set `status: "sent"`, `sentAt`, `sendProvider: "resend"`, `sendExternalId: <broadcast id>`, `addedAt`. The mint-on-send keeps numbering honest (a drafted-but-never-sent edition never gets a number).
- Public reads: `GET /editions` (`list_editions`, sent-only) + `GET /editions/{number}` (`get_edition`) — oRPC contracts under `/api/v1`, `-alias.ts` mirror at `/api`.

**Secret posture (unchanged):** the agent box holds only its admin token; `RESEND_API_KEY` (+ the audience id) is a **Worker secret**, declared in `env.ts` alongside the existing `LOOPS_*` secrets (which are removed once the send is cut over). The broadcast create/send happens **Worker-side** (the agent calls `POST /admin/editions/{id}/send`; the Worker holds the Resend key) — same model the rest of the pipeline uses, so no vendor key lands on the agent box.

---

## 4. The send — Resend (closes Problem 2)

The chosen provider, in build form. The same persisted edition, sent through a real broadcast API instead of a manual dashboard tap.

### 4.1 Subscribers — Resend is the list-of-record (no local table)

Today **Loops is the sole list-of-record**; there is **no `subscribers` table** (verified). The subscribe path (web form, CLI `subscribe`, MCP `subscribe_newsletter`, WebMCP) all funnel through `subscribeToNewsletter()` → Loops `contacts/create`.

- **Resend becomes the sole list-of-record** — the clean mirror of today's design. Repoint `subscribeToNewsletter()` from Loops `contacts/create` to Resend `POST /contacts` (same shape: email, `unsubscribed: false`, into the Fluncle audience); keep the confirmation as a Resend transactional send (or drop it). **No local `subscribers` table** — this preserves the current architecture (provider owns the list) and is the lowest-risk swap.
- **Not mirroring subscribers into our DB** is the deliberate choice: mirroring buys portability at the cost of owning subscriber PII + GDPR delete propagation. At 4 contacts, provider-as-list-of-record matches today's posture; revisit only if provider lock-in ever bites (it won't, at this scale).

### 4.2 The newsletter agent — the flow change

The agent (`docs/agents/newsletter-agent.md`) authors the edition today and **stages a Loops campaign**. The reworked flow:

1. **Author the edition** (unchanged): read the discovery window from `/api/tracks?since=&until=`, group finds by galaxy, pull the mixtape from `/api/mixtapes` if one landed, gather tidbits via firecrawl, write the intro + per-track "why" + subject — all in the Email register, routed through `copywriting-fluncle`.
2. **Persist the edition (NEW):** `POST /admin/editions` with the structured `contentJson` payload (intro, galaxy-grouped track `logId`s + per-track why, the mixtape ref, the tidbits + sources, the window, the subject). Creates a **draft** edition (no number yet) — the archive's source of truth. A thin `fluncle admin newsletter draft` CLI relay carries it (mirroring `fluncle admin track …`), `requireOperator`/`requireAdmin`-gated.
3. **Send + mint (Resend):** `POST /admin/editions/{id}/send` (relayed by `fluncle admin newsletter send`) renders the email HTML from the same payload, creates the Resend broadcast (`POST /broadcasts` against the Fluncle audience, `send: false` so it's a draft first — note Resend's constraint that **only API-created broadcasts can be API-sent**, satisfied here), then triggers the send. **The send guardrail (locked posture):** the broadcast is created as a draft and the operator triggers the send — either the one-line `fluncle admin newsletter send` (the explicit human gate replacing the old dashboard tap) or a `scheduled_at`. On a successful send the same transition **mints the sequential `number`**, sets `status: "sent"`, `sentAt`, `sendProvider: "resend"`, `sendExternalId: <broadcast id>`, `addedAt` — and the edition appears in the archive + index + RSS. The window cutoff that today lives in the Loops campaign name moves into `editions.windowUntil` (a real column now, not a parsed string); the self-heal ("a skipped week widens the next window; an unsent draft re-enters the window") is preserved by reading the last _sent_ edition's `windowUntil`.

The agent's safety rails carry over: one edition per run; only _sent_ editions anchor the window; the window cutoff is load-bearing (now a column); every fact comes from the API or a linkable firecrawl result.

### 4.3 Compliance + deliverability (the real responsibilities)

- **Managed unsubscribe.** Resend adds the RFC-8058 one-click `List-Unsubscribe` / `List-Unsubscribe-Post` headers for broadcasts; the LMX template body must carry the `{{{RESEND_UNSUBSCRIBE_URL}}}` token. The footer also carries a postal address line (CAN-SPAM). Both are template edits, done once.
- **Deliverability / domain warm.** A new sending domain/identity warms from zero. Mitigation: verify SPF/DKIM/DMARC on the Resend sending domain _before_ the first broadcast (approved — §5); a 4-contact list warms instantly; a single live test broadcast to the operator validates DKIM + the unsubscribe link + the one-source render before any subscriber sees it.
- **The list move never re-subscribes an opt-out.** With 4 contacts and 1 edition sent, unsubscribes are near-certainly zero, but the import still preserves any `unsubscribed` status (map Loops opt-outs to Resend `unsubscribed: true`). This is the one compliance-critical step (§5).

---

## 5. Migration (trivial — not a project)

**The list is 4 subscribers; they have received exactly 1 edition.** This is a five-minute hand-move, not a migration project, and the RFC scopes it as such.

### 5.1 Past editions — re-import the one edition by hand

There is **one** existing sent edition. Loops has no content-export API (verified — its API is contact + transactional; no "pull a sent campaign's rendered content" endpoint). So: **re-import it by hand.** Create one `editions` row (a one-off `fluncle admin newsletter draft` with the subject + the reconstructed `contentJson`, or by hand), mark it `sent` with its real send date so it gets `number = 1` and the right `sentAt`. One edition is a five-minute step. New editions persist automatically from the first build forward. (A Loops content-export integration for a one-row backfill would be gold-plating.)

### 5.2 The subscriber list — export 4, import 4

- **Export** the 4 Loops contacts (dashboard CSV, including subscription status). **Import** to Resend (`POST /contacts/imports` with `column_map`, or simply add 4 contacts by hand — at this size, by hand is faster), **preserving any unsubscribe status**. Owner-run (real people's emails — External Effects, approved).
- **Cutover:** import → verify the 4 carried (and any unsubscribe stuck) → repoint `subscribeToNewsletter()` to Resend → switch the agent's send step → stop sending from Loops, remove `LOOPS_*` secrets. One clean flip, no dual-send.

This is why the migration is a paragraph, not a phase: there is no back-catalog to speak of and no list to speak of.

---

## 6. Canon fit — the edition as a back-issue from the mothership

The edition is a **dispatch**: the weekly letter the uncle sends the mothership, now with a permanent home on `fluncle.com`. The canon already carries everything:

- **Register:** the existing **Email** register (VOICE.md §5) governs the email body verbatim — "A letter from the uncle to the crew… Opens 'Ahoy cosmonauts,' closes 'Happy raving, Fluncle'." No new register. The **archive page** is a web-register page (the nameplate, the intro shown as a back-issue) — the same letter, shown on the site.
- **Vocabulary:** **"the mothership"** is the canonical descriptor for the newsletter + its list ("you board it by subscribing… it departs every Friday; Fresh bangers, every Friday, from Fluncle"). The archive is "back issues from the mothership" / "past dispatches" — not "transmissions" / "signals" (banned identity words).
- **No coordinate, by design.** Unlike a mixtape, an edition has **no Log ID and no coordinate decode** — it is content, not a collectible (§2.2). The `/newsletter/<id>` page does not carry a `fluncle://` coordinate; the URL _is_ the identity. This is a deliberate canon distinction: coordinates mark collectible media (the stars you collect in the Galaxy games), and a letter is not collected.
- **Subordinate to canon:** the index copy, the back-issue framing, and the page chrome are `copywriting-fluncle` calls; DESIGN/PRODUCT/VOICE win on any conflict. The PRODUCT.md object paragraph (the newsletter archive object) and the spine-model "editions are NOT on the spine — content, not a collectible" note are part of done.

---

## Sequencing & ownership

**Gate (locked): runs AFTER the oRPC migration.** The oRPC slice (`docs/orpc-migration-brief.md`) is the sole active slice and must land first; the newsletter API is built on its contracts. Do not start the newsletter build while oRPC is mid-flight.

Then, A + B in one build week, targeting next Friday's edition:

1. **The editions object + archive.**
   1. The `editions` table (integer `number`, no Log ID) + the generated migration; the sequential mint (`max(number)+1`, atomic).
   2. The oRPC contracts (`list_editions`, `get_edition`) + handlers; the `/newsletter/$id.tsx` page + `/newsletter` index (modeled on `mixtapes.index.tsx`).
   3. RSS UNION arm + `<category>edition</category>`; the `BlogPosting` JSON-LD at `/newsletter/<id>`; sitemap entries; the llms.txt Newsletter section. Editions do **not** increment `FOUND · N` and do **not** enter the feed.
   4. The admin contracts/routes (`create_edition`, `update_edition`, `send_edition`) + `fluncle admin newsletter draft|update|send`.
   - _Parallelizable once the table lands:_ the contracts+reads, the index/page, and the RSS/JSON-LD/sitemap/llms.txt wiring are independent.
2. **The send move to Resend (owner-run external steps approved).**
   1. Owner: create the Resend account, verify SPF/DKIM/DMARC on the sending domain, confirm free-tier covers 4 contacts + weekly volume. (Approved.)
   2. Add `RESEND_API_KEY` (+ audience id) as Worker secrets (`env.ts`); wire the broadcast create/send inside `send_edition`; repoint `subscribeToNewsletter()` to Resend; carry the `{{{RESEND_UNSUBSCRIBE_URL}}}` token + footer postal address in the LMX template.
   3. **De-risk:** one live test broadcast to a seed audience (the operator only) — proves DKIM/deliverability + the unsubscribe link + the one-source render before any real subscriber sees it.
   4. Owner: export the 4 Loops contacts → import to Resend (preserve any unsubscribe) → cutover → remove `LOOPS_*` secrets. Five minutes.
3. **Move the subscribe path:** `POST /api/v1/newsletter/subscribe` becomes canonical (`/api/newsletter` kept as a permanent alias); verify the web form + CLI + MCP + WebMCP subscribe paths still work.
4. **Docs:** rewrite `docs/agents/newsletter-agent.md` to the Resend flow; add the spine-model "editions are NOT on the spine" note; land the PRODUCT.md object paragraph; re-import the one past edition by hand.

**Deploy discipline:** all code ships through the normal Worker deploy (Workers Builds on push to `main`; watch for build coalescing on rapid pushes). The migration applies in the Cloudflare build. The Resend account/DNS and the 4-contact Loops export are owner-run, approved steps (External Effects).

---

## External Effects (all approved)

Per `AGENTS.md`, these touch a paid vendor / DNS / real people's emails. **All confirmed by the owner — execute, don't re-ask:**

1. **Resend account + cost.** Approved. Free-tier covers a 4-contact list + weekly volume; the **API key lives in the `Web Local Dev Env` 1Password item** (and is set as the `RESEND_API_KEY` Worker secret for prod). Confirm the exact current free-tier limits in-dashboard at setup — they move — but the cost is approved.
2. **SPF / DKIM / DMARC DNS on the sending domain.** Approved. Verify on the Resend domain before the first broadcast.
3. **Loops list export (4 contacts).** Approved. Export the 4 contacts with subscription status, import to Resend preserving any unsubscribe, then decommission Loops from the send path.

No other external effect is introduced. The Resend broadcast create/send is Worker-side (no vendor key on the agent box).

---

## Acceptance criteria

**The archive (the editions object) — ship gates:**

- [ ] The `editions` migration is **generated** via `db:generate` (not hand-written), committed with metadata, applies cleanly; the table has an integer `number` (minted on send), `status` draft→sent, `contentJson`, send provenance, window columns — **and no `logId` column**.
- [ ] `/newsletter/<number>` renders sent editions (subject, intro, galaxy-grouped finding links each → `/log/<finding-id>`, the mixtape ref, tidbits) — verified in a driven real browser **past hydration** (the `verify-interactive-states-visually` canon). **No coordinate decode, no `/log/<id>` branch — `resolveLogPageTarget` is untouched.**
- [ ] `/newsletter` index lists sent editions newest-first (modeled on `mixtapes.index.tsx`); `GET /api/v1/editions` (+ `/api/editions` alias) returns sent editions as JSON via an **oRPC contract** (`list_editions` / `listEditions`); `GET /editions/{number}` (`get_edition`) returns one. **A coverage test confirms each public route has a contract/operationId** (the oRPC-brief rule).
- [ ] RSS gains a third UNION arm with `<category…>edition</category>` linking `/newsletter/<id>`; the edition page emits `BlogPosting` JSON-LD; the sitemap lists `/newsletter` + each sent `/newsletter/<id>`; llms.txt gains a Newsletter/Editions section. Editions do **not** increment `FOUND · N` and do **not** appear in the `/api/tracks` feed.
- [ ] `POST /admin/editions` (`create_edition`, draft) + `PATCH /admin/editions/{id}` (`update_edition`) + `POST /admin/editions/{id}/send` (`send_edition` — mint the sequential number, set `sent`/`sentAt`/provenance) exist, `requireOperator`/`requireAdmin`-gated, mirroring the mixtape admin routes; `fluncle admin newsletter draft|update|send` thin CLI relays are wired. **Unit tests** mirror the mixtape test shape (the sequential mint math, the sent-only reads, the eligibility gates).
- [ ] One stored `contentJson` payload renders **both** the email HTML (LMX, filled) and the web archive page — same source, verified identical content.
- [ ] `docs/agents/newsletter-agent.md` is rewritten to the persist-then-Resend flow; the one existing past edition is re-imported by hand (`number = 1`). PRODUCT.md gains the newsletter-archive object paragraph; the spine model gets the "editions are NOT on the spine" note.

**The Resend send + the subscribe move — ship gates:**

- [ ] `RESEND_API_KEY` (+ audience id) added to `env.ts` as Worker secrets (key in the `Web Local Dev Env` 1Password item); the broadcast is created + sent **Worker-side** inside `send_edition` (the agent holds only its admin token).
- [ ] A live test broadcast to a seed audience (operator only) verifies DKIM/deliverability, the managed `{{{RESEND_UNSUBSCRIBE_URL}}}` + one-click `List-Unsubscribe`, and the LMX footer (unsubscribe link + postal address) **before** the cutover.
- [ ] The 4 Loops contacts are exported and imported to Resend **with any unsubscribe preserved**; `subscribeToNewsletter()` is repointed from Loops `contacts/create` to Resend `POST /contacts`; **the subscribe POST moves to `POST /api/v1/newsletter/subscribe`** (`subscribe_newsletter`, the `/api/newsletter` path kept as a permanent alias); the web form + CLI + MCP + WebMCP subscribe paths all still work.
- [ ] The agent's send step is a Resend broadcast (draft + the explicit send step); the window cutoff lives in `editions.windowUntil`; the self-heal (last _sent_ edition anchors the next window) is preserved. **A sent edition mints its number and records `sendProvider: "resend"` + `sendExternalId` + `sentAt`.**
- [ ] Loops is decommissioned from the send path (no dual-send; `LOOPS_*` secrets removed); `docs/agents/newsletter-agent.md` reflects the Resend flow.

**Not a ship gate (honest scoping):** a Loops content back-import (one row, done by hand); a local `subscribers` mirror table (Resend stays list-of-record); MCP `list_editions` / `get_edition` tools (thin, optional); a `fluncle newsletter` reader beyond the alias.

---

## Risks & open questions

- **Domain warm (the one real risk).** A new sending identity warms from zero; a botched SPF/DKIM/DMARC setup tanks the first send. Mitigated by verifying DNS first (approved) + a seed-audience test broadcast before cutover; a 4-contact list warms instantly.
- **Compliance on the move.** Resend manages the unsubscribe mechanism, but we must carry the token in every broadcast and the postal address in the footer, and preserve any opt-out on the 4-contact import. Low risk at this size; the import is the one compliance-critical action.
- **Convention B is exercised live here.** This is the first new feature on the ratified convention + the oRPC contracts. If the oRPC slice changes a projection rule at kickoff, the newsletter contracts inherit it — which is the point of sequencing after oRPC. No dangling thread: the registry table (§3.2) is the contract.
- **Identity reworked away from the spine.** Editions deliberately leave the Log-ID spine (§2.2). This is the intended distinction (collectible media vs content), not an omission. Revisit only on a genuinely strong lore reason — there isn't one.
- **Loops has no content-export API.** Verified; mitigated by the one-row hand re-import. If the back-catalog were large this would matter — it's one edition.

---

## Appendix — verifications & sources

**Live code verifications (against the worktree):**

- **The mixtape fan-out is the shape precedent (identity is NOT reused):** the `mixtapes` table shape + the atomic sequence mint in `apps/web/src/lib/server/mixtapes.ts` (`publishMixtape`), the draft→sent lifecycle; `MIXTAPE_SELECT` (externalUrls derived by subquery). The edition reuses the **table + counter + lifecycle** shape but mints a plain integer `number`, not a Log ID — so `mixtape-log-id.ts` is the _structural_ test model, not a code dependency, and `resolveLogPageTarget` / `isMixtapeLogId` / the `/^\d{3,4}\.F\.\d[A-F]$/` pattern in `lib/log-id.ts` are **untouched** (no `isEditionLogId`, no resolver branch).
- **The fan-out precedents:** RSS UNION + `<category domain="…/ns/object-type">mixtape</category>` in `apps/web/src/routes/rss[.]xml.ts`; the `/mixtapes` index + `ItemList` JSON-LD in `mixtapes.index.tsx` (the layout model for `/newsletter`); `MusicAlbum` / `DJMixAlbum` JSON-LD in `apps/web/src/lib/log-schema.ts` (the model for a `BlogPosting`, emitted at `/newsletter/<id>` not `/log`); the llms.txt Mixtapes section in `apps/web/public/llms.txt`; the heterogeneous feed (`FeedItem` in `packages/contracts/src/index.ts`, merged in `tracks.ts`) — editions are **not** added to this feed (content, not collectible).
- **The current email/Loops surface:** `apps/web/src/lib/server/newsletter.ts` (`subscribeToNewsletter` → Loops `contacts/create` + transactional confirmation; `LOOPS_API_KEY` / `LOOPS_TRANSACTIONAL_ID`); the subscribe routes `apps/web/src/routes/api/newsletter.ts` + `apps/web/src/routes/api/v1/newsletter.ts` (the path the subscribe POST moves OFF — to `/newsletter/subscribe` — with the bare path kept as an alias); the CLI `apps/cli/src/commands/subscribe.ts`; the MCP tool `mcp.ts` `subscribe_newsletter` + WebMCP `webmcp.ts`; **no `subscribers` table** in `apps/web/src/db/schema.ts` (Loops → Resend as sole list-of-record). The admin pattern: `requireAdmin` / `requireOperator` in `env.ts`, `adminApiPost` in the CLI; the mixtape admin routes (`api/admin/mixtapes*`) as the endpoint template.
- **The LMX email source:** `docs/agents/newsletter-template.lmx` (the `<Style>`, the "Ahoy cosmonauts," greeting, the `SLOT_*` word-slots, the "Happy raving, Fluncle" sign-off — gains the `{{{RESEND_UNSUBSCRIBE_URL}}}` token + a postal footer line); the agent doctrine `docs/agents/newsletter-agent.md` (the window self-heal, "only sent campaigns anchor the window," the Loops-can't-send-by-API fact).
- **Convention B + oRPC rails (the API basis):** `docs/naming-conventions.md` Convention B (verb_noun registry; MCP = `verb_noun`, operationId = `verbNoun`, REST resource path, named-action sub-resource for non-CRUD, plural collections) — **ratified** (referenced as such in `AGENTS.md` and `docs/orpc-migration-brief.md`); the oRPC contract pattern (`packages/contracts/orpc`, `OpenAPIGenerator`, the coverage test that fails on an un-contracted public route) from `docs/orpc-migration-brief.md` + `docs/rfcs/openapi-generation.md`. The newsletter contracts (`list_editions`, `get_edition`, `subscribe_newsletter`, + the admin ops) follow these rules and are the convention's first new-feature test.
- **Canon:** the Email register (VOICE.md §5 / `packages/skills/copywriting-fluncle/references/voice.md`: "A letter from the uncle to the crew… Opens 'Ahoy cosmonauts,' closes 'Happy raving, Fluncle'"); **"the mothership"** = the newsletter + its list; the Log-ID-is-for-collectible-media distinction (the spine-model double-read describes collectible media — editions are deliberately excluded).

**Vendor verifications (via Context7, dated 2026-06-21):**

- **Resend — full programmatic broadcast (chosen).** `POST /broadcasts` creates a broadcast to an audience (optionally `send: true` or `scheduled_at`); `POST /broadcasts/{broadcast_id}/send` triggers it — with the constraint **"you can only send broadcasts that were originally created via the API"** (satisfied: the agent creates it via API). Audiences/Segments + Contacts API (`POST /contacts`, `unsubscribed` flag); CSV import `POST /contacts/imports` with `column_map`. Managed unsubscribe via `{{{RESEND_UNSUBSCRIBE_URL}}}` in broadcast HTML; for bulk, Resend adds the RFC-8058 `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header. **Sends from Cloudflare Workers** (documented; plain HTTPS API, SDK or raw `fetch`). Webhooks `email.sent` / `email.bounced` / `email.complained` (the `sent` payload carries `broadcast_id`). SPF/DKIM/DMARC verification (Gmail/Yahoo 2024 bulk rules). Source: Resend docs via Context7 `/websites/resend`, `/llmstxt/resend_llms_txt`. _Confirm current free-tier limits in-dashboard — they move._
- **Cloudflare Email Service — transactional-only (rejected).** Its FAQ: **"currently intended for transactional emails only. Support for marketing emails and bulk sender tooling is planned for the future."** A single-recipient `env.EMAIL.send(...)` Worker binding; no audiences, no broadcast, no suppression, no managed unsubscribe. Source: Cloudflare Email Service docs via Context7 `/websites/developers_cloudflare_email-service`.
- **Loops — no programmatic campaign-send, no content-export (the blocker).** Confirmed against the agent doctrine + the ROADMAP (CLI/SDK/API/docs all dashboard-only for campaign send); the API is contact + transactional, with no sent-campaign content-export endpoint. This is exactly what motivates moving the send to Resend and re-importing the one past edition by hand.

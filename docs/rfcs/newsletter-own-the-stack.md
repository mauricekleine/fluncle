# RFC: Own the newsletter stack — a spine-native archive, and move the send off Loops

**Status:** Final (research → vendor verification via Context7 → spine + email-surface code grounding, 2026-06-21) — completeness standard applied.
**For:** a fresh build session (or a small team of agents) standing up the editions spine + the send migration, plus Maurice for the provider/paid-vendor calls, the Loops-list export, and the canon sign-off.
**Canon/authority:** the codebase and `AGENTS.md` arbitrate; `docs/track-lifecycle.md`, the mixtape spine model (`packages/skills/fluncle-mixtapes/references/spine-model.md`), `docs/agents/newsletter-agent.md`, `VOICE.md` / `packages/skills/copywriting-fluncle`, and the live `fluncle` CLI + `/api/v1` are the ground truth. This is planning under `docs/`, not spec. The `docs/ROADMAP.md` "Newsletter archive — bring the editions home" note is the seed; this turns it into a build-ready plan and answers the bigger coupled question it raises (whether to leave Loops).

> Process note: the two problems below are coupled, and the RFC is built around that coupling. Research ran across three threads — the mixtape spine implementation (the precedent for a spine-native non-track object), the current email/Loops/subscriber surface, and the provider landscape (Resend, Cloudflare Email Service, with SES/Postmark/Buttondown weighed) — each grounded in the real worktree files and, for the vendors, in current docs pulled through Context7 on 2026-06-21. The decisive vendor facts are quoted in the appendix, not reasoned from memory. Two facts settle the core decision: **Resend has a real programmatic broadcast-send API** (create + send a broadcast to a segment/audience over HTTP, managed unsubscribe, one-click `List-Unsubscribe`), and **Cloudflare Email Service is transactional-only by its own FAQ** ("currently intended for transactional emails only… bulk sender tooling is planned for the future").

---

## The standard (definition of done)

This RFC describes a complete delivery, not a menu. The two problems are solved together because the same artifact — a persisted edition — solves both. When it is built:

- **Both problems are closed by one data model.** The archive exists (every edition is readable on `fluncle.com` forever), and — if the recommended provider path is taken — the Friday send is no longer a manual dashboard tap. A build that ships the archive but leaves the send manual is the **explicitly sanctioned smaller scope** (Approach A below), not a half-done version of the larger one; the owner picks the scope in Decisions.
- **The edition is a real spine object, end to end.** A marked Log ID, a `/log/<id>` edition page rendered through the existing universal resolver, a `/newsletter` index, quiet feed + RSS inclusion as a third item type, JSON-LD, and the llms.txt section. Sourced from the content the agent already authors, persisted at draft time, and rendered into **both** the web archive page and the email HTML from one stored payload. An archive page that re-implements the email layout by hand, or an email that isn't the same source as the page, is not done.
- **Tests + docs are part of done.** New server code (the editions table + mint, the `/api/admin/newsletter` endpoints, the resolver branch, the RSS/feed UNION, the public DTO) ships with unit tests in `apps/web` (+ `apps/cli` for the new command), mirroring the mixtape test shape (`mixtape-log-id.test.ts`, the route tests). `docs/agents/newsletter-agent.md` is rewritten to the new flow; the spine model gets an "editions" note; the canon stubs land per the mixtape precedent (PRODUCT.md object line, the VOICE register row already exists — Email).
- **The only sanctioned "not now"** is genuine sequencing or an owner-gated external step: the editions table + the archive (Approach A) must land before the send migration can read from it; the Loops subscriber-list export and the new paid vendor are owner-gated (External Effects). Those are sequencing/ownership, not deferral.

A note on altitude: this is **not** a load-bearing-infra change masquerading as a doc. The newsletter is a small, slow surface (one edition a week, a hobby D&B list). The archive half is cheap and high-value (it makes a whole class of Fluncle's writing permanent and crawlable). The send-migration half is the genuinely consequential call — it trades a managed sender's deliverability/compliance for a real send API — and the RFC treats it as the real decision it is, with the honest risks stated, and a recommendation that keeps the cheap win available even if the owner declines the migration.

---

## 0. Summary / the reframe

**The unifying simplification: we have to persist editions either way, so persistence is the spine — and once editions live in our DB, the send provider becomes a swappable detail.** Everything follows from that one fact.

- **Problem 1 — no archive.** Past editions live only in Loops: sent, then gone. There is no way to read a previous Friday letter anywhere on `fluncle.com` / the Galaxy. The newsletter is the one Fluncle writing surface with no permanent home — every finding, every mixtape has a `/log/<id>`; the letter the uncle writes the crew evaporates.
- **Problem 2 — Loops blocks auto-send.** The Friday agent (`docs/agents/newsletter-agent.md`) authors the whole edition, then can only **stage** a Loops campaign — Loops has no programmatic campaign-send (CLI/SDK/API/docs all confirm; dashboard-only), so the weekly send is a manual operator tap. Verified still true. This is the one weekly-cadence manual step in an otherwise automated pipeline.
- **Why they're coupled.** The archive forces us to persist each edition's content in our own DB. Once it's persisted, keeping Loops _only to send_ is the odd part: we'd be paying a managed sender to do the one thing (send a stored payload to a list) that a send-API provider does in one HTTP call — while _also_ owning the content. So the archive work naturally pulls the question "should the send move off Loops too?" — which is exactly the bigger decision this RFC exists to answer.
- **The spine precedent is exact and already proven.** A **mixtape** is the model: a non-track object on the Log ID spine, with its own `F`-marked coordinate, a universal `/log` resolver, a dedicated `/mixtapes` index, quiet feed + RSS inclusion as a distinct item type, its own JSON-LD, and an llms.txt section. An **edition** is the same shape with a different marker. There is almost **no new spine architecture** — there's a new table, a new marker letter, one resolver branch, one RSS UNION arm, one index page, and the agent-flow change. The discipline is making the edition _look like the mixtape_, not inventing a parallel spine.
- **The provider answer, up front (the core decision).** Of the three honest options:
  - **(A) Keep Loops to send, mirror editions to our DB for the archive.** Minimal, lowest-risk, keeps the managed sender's deliverability. **The send stays a manual tap** — Problem 2 is _not_ solved. This is the right floor if the owner doesn't want to leave a managed sender yet.
  - **(B) Move the whole flow to Resend.** Resend has a real broadcast API: create + send a broadcast to an audience/segment over HTTP, managed unsubscribe (`RESEND_UNSUBSCRIBE_URL`) with automatic RFC-8058 one-click `List-Unsubscribe`, CSV contact import, Workers-native sending, and bounce/complaint webhooks. **This closes the auto-send gap** while still leaving us a managed sender for deliverability. **Recommended** for the full-ownership path.
  - **(C) Cloudflare Email Service.** Researched against its own docs: **transactional-only today** — no audiences, no broadcast/campaign send, no suppression list, no managed unsubscribe; its FAQ says bulk/marketing tooling is "planned for the future." Using it for the newsletter means **rolling our own** subscriber table, suppression list, unsubscribe endpoint, and per-recipient send loop on top of a single-recipient transactional `env.EMAIL.send()`. That is a real email-platform build (deliverability, compliance, bounce handling all on us) for a hobby list. **Not recommended** until Cloudflare ships bulk tooling.
  - **The recommendation: ship Approach A first (the archive — cheap, high-value, closes Problem 1), then move the send to Resend (Approach B — closes Problem 2) as the owner-gated follow-on.** Resend over Cloudflare because Cloudflare can't do broadcasts yet; Resend over roll-our-own-on-Cloudflare because owning deliverability + suppression + compliance for a weekly hobby letter is effort with downside and no upside.
- **Decomposition (truly-coupled vs falsely-coupled):**
  - **Unit A — the editions spine + archive.** The headline. The editions table + mint, the `/log/<id>` edition page (resolver branch), the `/newsletter` index, feed/RSS/JSON-LD/llms.txt inclusion, and the **render-from-one-source** rule (the stored payload renders both the web page and the email HTML). Ships standalone and is useful immediately; **does not require leaving Loops** (the agent mirrors the same payload it stages to Loops). This _is_ Approach A.
  - **Unit B — the send migration to Resend.** The provider swap: a Resend audience, the import of the Loops list, the broadcast-create-and-send from the agent (or a Worker endpoint), managed unsubscribe + `List-Unsubscribe`, the subscribe path repointed from Loops `contacts/create` to Resend `contacts`. Depends on Unit A (it sends the persisted edition's HTML); **owner-gated** (paid vendor + leaving a managed sender). This is the Approach A→B upgrade.
  - **Falsely-coupled — the subscriber list-of-record.** "Move the list off Loops" and "persist editions" are independent. Unit A doesn't touch the list at all (Loops stays list-of-record). The list only moves in Unit B, and even then the question of _whether we mirror subscribers into our DB_ is a separate sub-decision (§4) — Resend can stay list-of-record exactly as Loops is today.
  - **Falsely-coupled — the agent runtime.** Nothing here needs a new agent or box. The Friday agent gains one step (persist the edition via a new admin command) and, in Unit B, swaps "stage Loops campaign" for "create + send Resend broadcast." Same Spinup agent, same harness.

---

## 1. Context & goals

**Why now.** The ROADMAP already carries the seed ("Newsletter archive — bring the editions home… ideally spine-native like a mixtape"). The mixtape shipped the entire spine-native-non-track-object pattern, so the archive is now a _follow-the-precedent_ job rather than a design problem. And the auto-send gap is a real, recurring friction: every Friday the agent does 100% of the authoring and then a human has to open the Loops dashboard and press Send. Persisting editions for the archive is the natural moment to ask whether Loops should stay in the loop at all.

**Goals, honestly calibrated:**

- **In reach now (Unit A, no owner gate):** every edition persists to our DB at draft time and gets a permanent, crawlable `/log/<id>` home + a `/newsletter` index, rendered from the same source as the email. Closes Problem 1. Loops untouched.
- **In reach, owner-gated (Unit B):** the Friday send becomes a programmatic Resend broadcast — no dashboard tap. Closes Problem 2. Trades a managed sender we know for another managed sender with a send API.
- **Outside scope / non-goals:** building our own ESP (suppression, bounce-processing, IP warming) on Cloudflare Email Service transactional sends — explicitly _not_ recommended; a visual drag-and-drop email builder (the LMX template + the stored payload are the source, by design); per-subscriber personalization beyond a first-name token; double-opt-in changes (today's single-opt-in + confirmation courtesy is kept unless the owner wants otherwise); analytics dashboards.

**Canon / PRODUCT fit (stated plainly).** The newsletter is canon: it's **"the mothership"** — "the newsletter and its list. You board it by subscribing… it departs every Friday" (voice canon). The **Email register** already exists in VOICE.md §5 ("A letter from the uncle to the crew… Opens 'Ahoy cosmonauts,' closes 'Happy raving, Fluncle'"). So unlike the radio/observation RFC, **no new register is needed** — the edition is written in the register that already governs the email. The new thing is that the letter now _persists_ as a Galaxy surface: a dispatch with a coordinate, the same double-read as a mixtape (to an outsider, a back-issue page; to the crew, a checkpoint in the journey). Publishing stays operator-controlled in spirit even under auto-send: the agent drafts, and the human keeps a review window (the campaign-name window is self-healing today; an auto-send variant keeps a hold/confirm — §5).

---

## 2. Unit A — the editions spine (the archive)

The edition becomes a first-class spine object, modeled exactly on the mixtape. The mixtape proves every piece of this works; the edition reuses each one.

### 2.1 The object: an edition is not a finding and not a mixtape

A finding is one banger. A mixtape is a consolidation of findings (Fluncle dreaming). An **edition** is a weekly dispatch — a letter to the crew naming the week's finds. They share the spine; the differences are load-bearing:

- An edition is **not a "find"** — it does **not** increment the `FOUND · N` counter (same as a mixtape; the feed-count is findings-only, verified in `feedFindingsCount`).
- It is **not** a track (no ISRC, no BPM/key chip row) and **not** a mixtape (no Mixcloud/YouTube distribution, no member-track audio).
- It **is** a first-class object on the Log ID spine with a permanent coordinate and its own `/log` page. It _references_ findings (the week's tracks) the way a mixtape references members, but a track can appear in many editions over time, so the membership is a soft reference list, not the frozen tracklist a mixtape mints.

### 2.2 Identity — the edition Log ID (a new marker)

A mixtape's tell is the literal `F` in the middle slot (`019.F.1A`), where a finding carries a digit. An edition needs its own learnable marker in the same `XXX.Y.ZZ` family. Recommendation: the middle slot is the literal letter **`N`** (Newsletter), with the tail as the edition's sequence number.

- **Sector (`XXX`)** = days since the Fluncle epoch (2026-05-30) to the edition's send date — identical rule to findings and mixtapes (the `sector()` helper in `log-id.ts`, already shared).
- **Marker (`N`)** = the middle slot, always the literal `N`. A finding's is a digit; a mixtape's is `F`; an edition's is `N`. One letter is the whole tell, on-format and quiet. _(Owner decision — the exact letter is a canon call; `N` reads cleanly and can't collide with a finding-digit or the mixtape `F`. See Decisions.)_
- **Number (`ZZ`)** = the edition's sequence number (see the tail-shape decision below).

**Why a new marker, not reusing `F`:** the resolver branches on the middle slot to pick the object type (mixtape vs finding today). A distinct `N` means the resolver can route `/log/<id>` to the edition flavor with zero ambiguity, and `XXX.N.ZZ` can never collide with a finding (digit middle) or a mixtape (`F` middle) — exactly the property the mixtape `F` buys, no alphabet surgery.

**The cap-54 caveat is different here.** The mixtape's `<digit><letter>` tail caps at 54 (9×6) because mixtapes are rare. **Editions are weekly** — 54 weeks is ~one year, so a `<digit><letter>` tail would exhaust fast. **Decision: the edition tail must hold more than 54.** Two clean options, owner's pick (Decisions): (a) a 3-char zero-padded numeric tail (`001`…`999`, still on-format width — ~19 years of weeklies), or (b) keep `<digit><letter>` but let the letter run `A–Z` (9×26 = 234, ~4.5 years). Recommendation: **a zero-padded numeric tail** (`XXX.N.001`) — editions are a high-cadence series where a human-meaningful count ("Edition No. 37") matters more than the hex-flavored mixtape disguise, and the `N` already carries the "this is a different object" tell. The minting math mirrors `publishMixtape`'s atomic `next_sequence` CTE exactly, with the editions table as its own counter.

### 2.3 The data model — an `editions` table

Following the `mixtapes` table shape (its own table, its own counter, a `logId`/`sequenceNumber` minted on send, a draft→sent lifecycle). The stored **content payload is the single source** that renders both the web page and the email HTML.

```ts
// apps/web/src/db/schema.ts — a new table, modeled on `mixtapes`
export const editions = sqliteTable("editions", {
  id: text("id").primaryKey(),
  logId: text("log_id").unique(), // XXX.N.ZZ — minted on send, null while draft
  sequenceNumber: integer("sequence_number").unique(), // the counter, like mixtapes
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
  // Provenance of the send (Unit B): which provider + the broadcast/campaign id,
  // so a re-send is idempotent and the archive records how it went out. Null in
  // Approach A (Loops campaign id can be mirrored here if wanted).
  sendProvider: text("send_provider"), // "loops" | "resend"
  sendExternalId: text("send_external_id"), // Loops campaign id / Resend broadcast id
  sentAt: text("sent_at"),
  addedAt: text("added_at"), // feed/RSS ordering — set on send
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

- **Why a JSON content payload, not stored LMX/HTML:** the archive page is a `/log` surface in Fluncle's web register, _not_ an email rendered in a browser. Storing the _structured_ edition (intro text, the ordered track references by `logId`, the optional mixtape reference, the tidbits) lets us render two different presentations — the email HTML (the LMX template, filled) and the web archive page (the site's components) — from one source, which is the load-bearing "one source → both renders" requirement. Storing raw LMX would couple the archive to email markup; storing track _references by logId_ (not denormalized copies) keeps the archive live (a finding's title/cover updates if it changes) and tiny.
- **Track references, not frozen copies:** the payload stores each finding's `logId` + the agent's per-track "why" line (the editorial sentence the agent wrote _for this edition_, which may differ from the finding's own `note`). The archive page hydrates the live finding from `tracks` by `logId` (cover, title, artists) and overlays the edition's "why." This mirrors how a mixtape stores member `trackId`s and hydrates them, not denormalized track rows.
- **No subscriber data in this table.** Editions are content; the list is the provider's concern (§4). Keeping them separate is why Unit A can ship without touching Loops.

**Generate the migration** (never hand-write SQL — `AGENTS.md`): `bun run --cwd apps/web db:generate`, committed with its metadata. It applies automatically in the Cloudflare build (`deploy:cf` → `db:migrate`).

### 2.4 The universal resolver branch

`/log/<id>` already resolves findings _and_ mixtapes through one resolver (`resolveLogPageTarget` in `lib/server/log-resolver.ts`), branching on `isMixtapeLogId(idOrLogId)` (the `/^\d{3,4}\.F\.\d[A-F]$/` pattern in `lib/log-id.ts`). The edition adds a sibling branch:

```ts
// lib/log-id.ts — a sibling to isMixtapeLogId
const EDITION_LOG_ID_PATTERN = /^\d{3,4}\.N\.\d{3}$/; // XXX.N.001 (tune to the chosen tail)
export function isEditionLogId(value: string): boolean {
  return EDITION_LOG_ID_PATTERN.test(value);
}

// lib/server/log-resolver.ts — added to resolveLogPageTarget, before the track fallback
if (isEditionLogId(idOrLogId)) {
  const edition = await getEditionByLogId(idOrLogId);
  return edition ? ({ kind: "edition", edition } as const) : undefined;
}
```

The `/log/$logId.tsx` route then renders an `EditionLogPage` flavor (the third arm beside the finding and `MixtapeLogPage` flavors), exactly as the mixtape flavor was added: the edition's subject as the nameplate, the intro, the galaxy-grouped finding links (each `/log/<finding-id>`), the mixtape link if present, the tidbits with sources, and the coordinate decode ("the middle `N` marks a newsletter edition"). It is the same content the email carries, rendered in the web register.

### 2.5 The fan-out (build map) — every surface the mixtape touches

| Surface     | A mixtape does                                      | An edition does                                                                                                                                                  |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/log/<id>` | compilation page                                    | **dispatch page**: subject, intro, the week's findings (galaxy-grouped, each linked), the mixtape ref, tidbits, coordinate decode                                |
| Web index   | `/mixtapes`                                         | a dedicated **`/newsletter`** archive (newest first), modeled on `mixtapes.index.tsx`                                                                            |
| Web feed    | quiet checkpoint row                                | a quiet **edition row** when feed-included (own marker, subject, "Edition No. N") — _or kept index-only; see Decisions_                                          |
| API         | `/api/mixtapes`, mixtape-typed in `/api/tracks/:id` | `/api/editions` (+ `/api/v1/editions`); the resolver returns an edition-typed object at `/api/tracks/:logId`                                                     |
| RSS         | UNION arm + `<category>mixtape</category>`          | a third UNION arm + `<category…>edition</category>` (a third `item_type`)                                                                                        |
| JSON-LD     | `MusicAlbum`/`DJMixAlbum`                           | a non-music type — **`BlogPosting`** (or `Article`), `datePublished` = sentAt, `author` = Fluncle, `about` referencing the findings — modeled on `log-schema.ts` |
| llms.txt    | a Mixtapes section                                  | a **Newsletter / Editions** section: "Fluncle's weekly dispatch; each edition has its own Log ID and `/log` page; the middle slot is `N`."                       |
| CLI         | `fluncle mixtapes`                                  | `fluncle newsletter` (list editions) — thin, optional follow-on                                                                                                  |

**Naming collision to resolve (real, caught in grounding):** the **subscribe** endpoint already lives at `/api/newsletter` + `/api/v1/newsletter` (POST → `subscribeToNewsletter`). The **archive** wants a GET list. Two clean resolutions (Decisions): (a) the archive index is `/api/editions` + `/api/v1/editions` (cleaner — "edition" is the object noun, "newsletter" is the subscribe verb-surface), with the web page at `/newsletter`; or (b) keep `/newsletter` for the page but make the GET list `/api/newsletter/editions`. Recommendation: **`/api/editions` for the object, `/newsletter` for the human page** — the object noun is "edition," and it keeps the subscribe POST untouched.

### 2.6 One source → two renders (the load-bearing rule)

The stored `contentJson` is rendered twice:

1. **Email HTML** — the existing `docs/agents/newsletter-template.lmx` template, filled from the payload. In Approach A the agent fills the LMX and stages Loops exactly as today; in Approach B the same fill produces the HTML body for the Resend broadcast. Either way the _content_ comes from the persisted payload, so the archive and the email are guaranteed identical.
2. **Web archive page** — `EditionLogPage` renders the payload through the site's components (the web register), not the email markup.

The agent authors _once_ (the structured payload), persists it, and both renders derive from it. This is the answer to "rendered as both the web archive page and the email HTML from one source."

---

## 3. Unit B — the send migration (the core decision, in build form)

This is the owner-gated half that closes Problem 2. It is the same archived edition, sent through a provider with a real send API instead of a manual dashboard tap.

### 3.1 Provider evaluation (honest, against our stack)

Our stack is **Cloudflare Workers + Turso**, the list is small (a hobby D&B newsletter), and the agent already authors everything. The needs: programmatic broadcast to a list, audience/subscriber management, deliverability, unsubscribe + `List-Unsubscribe` + CAN-SPAM compliance, importing the Loops list, low cost at small scale.

**(A) Keep Loops to send + mirror editions to our DB.**

- _Send:_ manual dashboard tap (no campaign-send API — verified across CLI/SDK/API/docs). **Problem 2 unsolved.**
- _List + compliance + deliverability:_ all stay Loops-managed (today's behavior — `contacts/create` + `subscribed:true`, a transactional confirmation, Loops owns unsubscribe + `List-Unsubscribe` + deliverability).
- _Archive:_ Unit A persists the payload; Loops campaign id can be mirrored into `editions.sendExternalId`.
- _Cost:_ whatever Loops costs today; no change.
- _Verdict:_ the safe floor. Ship this regardless (it _is_ Unit A). It does not close the send gap.

**(B) Resend — recommended for the full path.** Verified via Context7 (appendix):

- _Send:_ **real programmatic broadcast** — `POST /broadcasts` (create, optionally `send: true` or `scheduled_at`) and `POST /broadcasts/{id}/send` to trigger. Note the constraint: **"you can only send broadcasts that were originally created via the API"** — fine for us (the agent creates it via API). Closes Problem 2.
- _Audience/subscriber management:_ Audiences + Segments + Contacts API (`POST /contacts`, `unsubscribed` flag, CSV import via `POST /contacts/imports` with `column_map`).
- _Unsubscribe + compliance:_ **managed** — `{{{RESEND_UNSUBSCRIBE_URL}}}` token in the broadcast HTML, and Resend adds the RFC-8058 one-click `List-Unsubscribe` / `List-Unsubscribe-Post` headers for broadcasts. SPF/DKIM/DMARC domain verification (Gmail/Yahoo 2024 bulk rules); deliverability insights in-dashboard.
- _Deliverability:_ managed sender, shared/dedicated IP per plan; reputation is Resend's to maintain (same _category_ of guarantee as Loops).
- _Workers fit:_ native — Resend documents sending from Cloudflare Workers; the API is plain HTTPS (raw `fetch` works, no SDK bundle needed on workerd).
- _Webhooks:_ `email.bounced` / `email.complained` (and `email.sent` carrying `broadcast_id`) — we can record suppression/health if wanted, but Resend already suppresses.
- _Cost at our scale:_ a free tier covers a small list + low monthly volume; confirm exact current limits in-dashboard before committing (numbers move — owner verifies). Pricing is the owner's gate (External Effects).
- _Verdict:_ closes the send gap, keeps a managed sender for deliverability + compliance, Workers-native, cheap at our scale. **Recommended.**

**(C) Cloudflare Email Service — researched, not recommended (yet).** Verified via Context7 (appendix):

- Its FAQ: **"currently intended for transactional emails only. Support for marketing emails and bulk sender tooling is planned for the future."**
- The API is a **single-recipient transactional send** — `env.EMAIL.send({ to, from, subject, html, headers })` from a Worker binding (or the REST `…/email/sending/send`). You _can_ set `List-Unsubscribe` / `List-Unsubscribe-Post` headers yourself.
- **No audiences, no broadcast/campaign send, no suppression list, no managed unsubscribe.** To run the newsletter on it we'd build: our own `subscribers` table, our own suppression list, our own unsubscribe endpoint + token, and a **per-recipient send loop** (one `EMAIL.send` per subscriber, with our own batching/retry/bounce handling). That is building an ESP for a weekly hobby letter — owning deliverability _and_ compliance _and_ bounce-processing with no managed safety net.
- _Verdict:_ **not recommended until Cloudflare ships bulk tooling.** The single attractive property (sending from the same Cloudflare account, no third-party) does not outweigh owning the entire list/suppression/compliance stack. Revisit when their marketing/bulk tooling lands.

**Others, weighed (mentioned only because the brief asks):**

- _Amazon SES_ — cheapest per-email at scale, but it's a raw SMTP/API relay: **no audience management, no broadcast, no managed unsubscribe** (same roll-our-own problem as Cloudflare, plus AWS setup). Wrong tool for a managed-broadcast need.
- _Postmark_ — excellent transactional deliverability, but **broadcast/marketing is a separate product (Broadcasts) and not its strength**; no better than Resend for our need, and Resend's broadcast + Workers story is cleaner.
- _Buttondown_ — a genuinely good fit _philosophically_ (a newsletter-native tool with an API, archive, RSS), but it would **duplicate the archive we're building ourselves** and add a second content home; we want the archive _on fluncle.com_, spine-native, not on a vendor's hosted archive. Its API could send, but it's a content tool we'd be fighting for ownership.

**The honest recommendation:** **A then B.** Ship the archive on Loops-as-is (A), then migrate the send to **Resend** (B). Resend is the only candidate that closes the auto-send gap _and_ keeps a managed sender's deliverability + compliance, with a Workers-native API. Cloudflare Email Service is the right answer only after it grows bulk tooling.

### 3.2 The risks of leaving a managed sender (stated plainly)

- **Deliverability/reputation transfer.** Moving senders means a new sending domain/identity warming up. Resend manages the IP reputation, but the _domain's_ sending history resets. Mitigation: verify SPF/DKIM/DMARC properly on the Resend domain _before_ the first broadcast; keep the list clean on import (don't import Loops-unsubscribed contacts as subscribed); the small volume warms gently. Risk is low at hobby scale but real — a botched DNS setup tanks the first send.
- **Owning unsubscribe + compliance correctly.** Even with Resend's managed unsubscribe, _we_ must ensure every broadcast includes the `RESEND_UNSUBSCRIBE_URL` token and that imported unsubscribed contacts stay unsubscribed (the import `unsubscribed` flag, and _never_ re-subscribing a contact who opted out in Loops). CAN-SPAM: physical address in the footer, honest "from," honest subject. Resend gives the mechanisms; using them correctly is on us. The LMX template footer must carry the unsubscribe link + a postal address line.
- **Two-providers-during-migration.** Between the list export and the cutover, both Loops and Resend hold the list. Mitigation: a clean cutover — export from Loops, import to Resend, flip the subscribe path + the agent's send step in one change, stop sending from Loops. Don't dual-send.
- **The auto-send guardrail.** Removing the manual dashboard tap removes the implicit human review gate. Mitigation: keep a hold — the agent creates the Resend broadcast as a **draft** (`send: false`) and the operator triggers `POST /broadcasts/{id}/send` (a one-line CLI command, or a scheduled `scheduled_at`), _or_ the agent sends but only after the operator approves in the run report. Either keeps publishing operator-controllable per PRODUCT.md while removing the dashboard dependency. (This is a Decision — full auto vs. one-tap-send-from-CLI vs. scheduled.)

---

## 4. Data model + the agent-flow change

### 4.1 Subscribers — move the list, or keep a list-of-record?

Today **Loops is the sole list-of-record**; there is **no `subscribers` table** in the schema (verified). The subscribe path (web form, CLI `subscribe`, MCP `subscribe_newsletter`, WebMCP) all funnel through `subscribeToNewsletter()` → Loops `contacts/create`.

- **Approach A:** no change. Loops stays list-of-record.
- **Approach B:** the list moves to Resend. The clean mirror of today's design is **Resend stays the sole list-of-record** — repoint `subscribeToNewsletter()` from Loops `contacts/create` to Resend `POST /contacts` (same shape: email, `unsubscribed: false`, into the Fluncle audience), keep the confirmation as a Resend transactional send (or drop it). **No local `subscribers` table needed** — this preserves the current architecture (provider owns the list) and is the lowest-risk swap.
- **Optional (a real decision, not a default):** mirror subscribers into our own `subscribers` table as _defense against provider lock-in_ (so the next migration is a DB export, not another vendor export). This is a genuine tradeoff: it buys portability at the cost of owning subscriber PII + GDPR delete propagation (we already have `userDataExports`/`userDeletionRequests` machinery, so it's not free of obligations). **Recommendation: do NOT mirror in Unit B** — keep the provider as list-of-record (matching today), and revisit only if provider lock-in ever bites. Stated as a Decision so it's a choice, not an omission.

### 4.2 The newsletter agent — the flow change

The agent (`docs/agents/newsletter-agent.md`) authors the edition today and **stages a Loops campaign**. The change is small and the same in both approaches for the _persist_ step:

1. **Author the edition** (unchanged): read the discovery window from `/api/tracks?since=&until=`, group finds by galaxy, pull the mixtape from `/api/mixtapes` if one landed, gather tidbits via firecrawl, write the intro + per-track "why" + subject — all in the Email register, routed through `copywriting-fluncle`.
2. **Persist the edition (NEW, both approaches):** `POST /api/admin/editions` with the structured `contentJson` payload (intro, galaxy-grouped track `logId`s + per-track why, the mixtape ref, the tidbits + sources, the window, the subject). This creates a **draft** edition (no Log ID yet) — the archive's source of truth. A thin `fluncle admin newsletter draft` CLI command relays it (mirroring `fluncle admin track …`), `requireOperator`/`requireAdmin`-gated.
3. **Send + mint:**
   - _Approach A:_ the agent also fills the LMX from the same payload and stages the Loops campaign exactly as today; the operator presses Send in Loops; **a follow-up `POST /api/admin/editions/{id}/sent`** (manual or via a tiny webhook) marks it `sent`, mints the `XXX.N.ZZ` Log ID (the atomic `next_sequence` CTE, like `publishMixtape`), sets `addedAt`, and the edition appears in the archive + feed + RSS. The mint-on-send keeps the coordinate honest (an edition that was drafted but never sent never gets a coordinate — matching the agent's existing "only sent campaigns anchor the window" self-heal).
   - _Approach B:_ the agent (or a `fluncle admin newsletter send` command) creates the Resend broadcast from the persisted edition's rendered HTML (`POST /broadcasts` against the Fluncle audience, `send: false`), and the send is triggered — auto, one-tap-from-CLI, or `scheduled_at` per the §3.2 guardrail decision. On a successful send, the same `sent` transition mints the Log ID, records `sendProvider: "resend"` + `sendExternalId: <broadcast id>` + `sentAt`. The window cutoff that today lives in the Loops campaign name moves into `editions.windowUntil` (cleaner — it's a real column now, not a parsed string), and the self-heal ("a skipped week widens the next window; an unsent draft re-enters the window") is preserved by reading the last _sent_ edition's `windowUntil`.

The agent's safety rails carry over unchanged in spirit: one edition per run; only _sent_ editions anchor the window; the window cutoff is load-bearing (now a column); every fact comes from the API or a linkable firecrawl result.

### 4.3 The admin endpoints (modeled on the mixtape admin routes)

- `POST /api/admin/editions` → `createEditionDraft(payload)` (`requireOperator`/`requireAdmin`) — mirrors `POST /api/admin/mixtapes`.
- `PATCH /api/admin/editions/{id}` → `updateEditionDraft` — edit the payload/subject before send.
- `POST /api/admin/editions/{id}/sent` (A) or `/send` (B) → mint the Log ID (atomic CTE), set `sent`/`sentAt`/provenance — mirrors `POST /api/admin/mixtapes/{id}/publish`.
- Public reads: `GET /api/editions` + `/api/v1/editions` (the archive list, sent-only) → `listEditions()`, modeled on `/api/mixtapes`; the resolver returns an edition at `/api/tracks/:logId`.

The secret posture is unchanged: the agent box holds only its admin token; `LOOPS_API_KEY` (A) or `RESEND_API_KEY` (B) stays a Worker secret (declared in `env.ts` alongside the existing `LOOPS_API_KEY`/`LOOPS_TRANSACTIONAL_ID`). The broadcast create/send happens **Worker-side** (the agent calls a thin admin endpoint, the Worker holds the Resend key) — same model the rest of the pipeline uses, so no vendor key lands on the agent box.

---

## 5. Migration

### 5.1 Past editions — is there a Loops read/export API?

**Researched:** Loops' API is contact + transactional + (limited) campaign-oriented; it is **not a content-export API** for past _sent_ campaign HTML. The newsletter agent doctrine already states the Loops CLI "cannot send campaigns" and treats Loops as send-only; there is no documented, reliable "pull every sent campaign's rendered content back out" endpoint. So:

- **Do not build a Loops back-import.** The number of past editions is tiny (the newsletter cadence is recent; per the ROADMAP/memory, essentially **one existing edition** to date). **Re-import by hand:** for each already-sent past edition, create an `editions` row by hand (or a one-off `fluncle admin newsletter import` with the subject + the reconstructed payload) and mark it `sent` with its real send date so its sector is correct. One edition is a five-minute manual step, not a migration project. New editions persist automatically from the first build of Unit A forward.
- This is honest scoping: a content-export integration for a one-row backfill would be gold-plating.

### 5.2 Exporting the subscriber list from Loops (Unit B only)

- Loops supports a **contact/audience export** (dashboard CSV export of contacts, including subscription status). Export the list, then **import to Resend** via `POST /contacts/imports` (CSV + `column_map`), **preserving unsubscribe status** (map Loops' unsubscribed contacts to Resend `unsubscribed: true` — never re-subscribe an opt-out; this is the CAN-SPAM-critical step). Owner-run (it's a list of real people's emails — External Effects).
- Cutover: import → verify counts + that unsubscribes carried → repoint `subscribeToNewsletter()` to Resend → switch the agent's send step → stop sending from Loops. One clean flip, no dual-send.

---

## 6. Canon fit — the edition as a Galaxy surface

The edition is a **dispatch**: the weekly letter the uncle sends the mothership, now with a permanent berth in the Galaxy. The canon already carries everything needed:

- **Register:** the existing **Email** register (VOICE.md §5) governs the email body verbatim — "A letter from the uncle to the crew… Opens 'Ahoy cosmonauts,' closes 'Happy raving, Fluncle'." No new register. The **archive page** is a `/log` surface, so its chrome (the nameplate, the coordinate decode) follows the web register the finding/mixtape log pages already use; the _content_ in the page is the same letter, shown as a back-issue.
- **Vocabulary:** **"the mothership"** is the canonical descriptor for the newsletter + its list ("you board it by subscribing… it departs every Friday; Fresh bangers, every Friday, from Fluncle"). The archive is "back issues from the mothership" / "past dispatches" — not "transmissions"/"signals" (banned identity words). The coordinate decode on the edition log page says the `N` marker plainly, in the dry web register the mixtape decode uses.
- **The double read (the Depth Gradient in object form, per the mixtape model):** to an outsider, `/newsletter` is a tidy archive of back issues; to the crew, each edition is a **checkpoint** in the journey — a marked coordinate that says "this is where the mothership was, this week." Same surface-legible-to-anyone / deeper-for-the-crew structure the mixtape spine canon describes.
- **Subordinate to canon:** the exact marker letter, the index copy, and the coordinate-decode lines are `copywriting-fluncle` calls; DESIGN/PRODUCT/VOICE win on any conflict. The PRODUCT.md object paragraph (like the mixtape one) and the spine-model "editions" note are part of done.

---

## Sequencing & ownership

1. **Unit A — the editions spine (closes Problem 1, no owner gate).**
   1. The `editions` table + the generated migration; the `isEditionLogId` pattern + the resolver branch; the mint CTE (modeled on `publishMixtape`).
   2. The `EditionLogPage` flavor on `/log/<id>`; the `/newsletter` index; the `/api/editions` (+ v1) reads.
   3. RSS UNION arm + `<category>edition</category>`; the JSON-LD `BlogPosting`; the llms.txt section; feed inclusion (or index-only — Decision).
   4. The admin endpoints (`POST /api/admin/editions`, `/sent`) + the `fluncle admin newsletter draft` command; rewrite `docs/agents/newsletter-agent.md` so the agent persists the payload (still staging Loops to send).
   5. Re-import the one existing past edition by hand.
   - _Parallelizable:_ the table+resolver, the index page, and the RSS/JSON-LD/llms.txt wiring are independent edits once the table lands.
2. **Unit B — the send migration to Resend (closes Problem 2, owner-gated).**
   1. Owner: approve Resend (paid vendor) + verify SPF/DKIM/DMARC on the sending domain; confirm the free-tier limits cover the list.
   2. Add `RESEND_API_KEY` (+ audience id) as Worker secrets; build the broadcast-create/send admin endpoint + `fluncle admin newsletter send`; repoint `subscribeToNewsletter()` to Resend; carry the unsubscribe token + footer postal address in the LMX.
   3. Owner: export the Loops list → import to Resend (preserving unsubscribes) → cutover.
   4. The agent's send step swaps Loops-staging for Resend-broadcast; the window cutoff moves into `editions.windowUntil`.
   - _The one thing that de-risks the most:_ a single live test broadcast to a tiny seed audience (just the operator) before the list cutover — proves DKIM/deliverability + the unsubscribe link + the one-source-render before any real subscriber sees it.

**Deploy discipline:** all code ships through the normal Worker deploy (Workers Builds on push to `main`; watch for build coalescing on rapid pushes). The migration applies in the Cloudflare build. The Loops export, the Resend import, and the DNS/domain verification are owner-run gated steps (External Effects).

---

## Decisions needed BEFORE handoff

1. **Scope: A only, or A then B?** A (archive, closes Problem 1) is cheap and unblocked — ship it regardless. B (send → Resend, closes Problem 2) is the owner call: leave a managed sender + take on a paid vendor + a domain-warm. _Recommended: ship A now; do B as the gated follow-on._
2. **Provider, if B (recommended, confirm):** **Resend** — only candidate with a real broadcast-send API + managed unsubscribe + Workers-native, keeping a managed sender. _Not_ Cloudflare Email Service (transactional-only today) or roll-our-own. Confirm.
3. **The edition marker letter (a canon call):** the middle slot. _Recommended:_ `N` (Newsletter) — can't collide with a finding digit or the mixtape `F`. Confirm the letter.
4. **The edition tail shape (real, because editions are weekly):** the `<digit><letter>` mixtape tail caps at 54 (~1 year). _Recommended:_ a zero-padded numeric tail (`XXX.N.001`, "Edition No. 37") since editions are a high-cadence human-counted series. Confirm the shape.
5. **The API/route naming (resolve the collision):** the subscribe POST already owns `/api/newsletter` + `/api/v1/newsletter`. _Recommended:_ the archive object lives at `/api/editions` (+ v1); the human page at `/newsletter`. Confirm.
6. **Feed inclusion:** does an edition appear as a quiet row in the main `/api/tracks` feed (like a mixtape via `includeMixtapes`), or stay index-only at `/newsletter` + RSS? _Recommended:_ RSS + `/newsletter` index, **index-only in the main feed** (the feed is finds + the occasional mixtape; weekly editions would dominate it). Confirm.
7. **Subscriber list-of-record (B only):** keep the provider (Resend) as sole list-of-record (matches today, lowest risk), or also mirror subscribers into our DB for portability (owns PII + GDPR propagation)? _Recommended:_ provider stays list-of-record; no local table. Confirm.
8. **Auto-send guardrail (B only):** full auto-send, one-tap `fluncle admin newsletter send`, or `scheduled_at` with a hold? _Recommended:_ the agent creates the broadcast as a draft; a one-line CLI/`scheduled_at` triggers it — keeps publishing operator-controllable per PRODUCT.md while killing the dashboard tap. Confirm.
9. **Paid vendor + DNS (owner, External Effects):** approve Resend's cost at our scale (verify the current free-tier limits in-dashboard) and the SPF/DKIM/DMARC setup on the sending domain.
10. **Loops list export (owner, External Effects):** export the contacts (with subscription status) and hand them off for the Resend import — preserving unsubscribes.

Everything else is settled here: the spine follows the mixtape precedent exactly (table + counter, universal resolver branch, dedicated index, RSS UNION + category, JSON-LD, llms.txt); one stored JSON payload renders both the email and the archive; the agent gains a persist step and (in B) swaps its send step; the secret posture is unchanged (vendor keys stay Worker-side); past editions are re-imported by hand (no Loops content-export build).

---

## Acceptance criteria

**Unit A (the editions spine / archive) — ship gates:**

- [ ] The `editions` migration is **generated** via `db:generate` (not hand-written), committed with metadata, applies cleanly; the table mirrors the `mixtapes` shape (own counter, `logId`/`sequenceNumber` minted on send, draft→sent lifecycle).
- [ ] `isEditionLogId` + the `resolveLogPageTarget` branch route `/log/<XXX.N.ZZ>` to the edition flavor; an edition log page renders the subject, intro, galaxy-grouped finding links, the mixtape ref, tidbits, and the coordinate decode — verified in a driven real browser **past hydration** (the `verify-interactive-states-visually` canon).
- [ ] `/newsletter` index lists sent editions (newest first), modeled on `mixtapes.index.tsx`; `GET /api/editions` (+ `/api/v1/editions`) returns editions as JSON; the resolver returns an edition at `/api/tracks/:logId`.
- [ ] RSS gains a third UNION arm with `<category…>edition</category>`; the edition log page emits `BlogPosting` JSON-LD; llms.txt gains a Newsletter/Editions section. Editions do **not** increment `FOUND · N`.
- [ ] `POST /api/admin/editions` (create draft) + `POST /api/admin/editions/{id}/sent` (mint Log ID via the atomic CTE, set `sent`/`sentAt`) exist, `requireOperator`/`requireAdmin`-gated, mirroring the mixtape admin routes; a `fluncle admin newsletter draft` thin CLI relay is wired. **Unit tests** mirror `mixtape-log-id.test.ts` + the mixtape route tests (the mint math, the resolver branch, the eligibility/sent-only reads).
- [ ] One stored `contentJson` payload renders **both** the email HTML (LMX, filled) and the web archive page — same source, verified identical content.
- [ ] `docs/agents/newsletter-agent.md` is rewritten so the agent persists the payload before/while staging the send; the one existing past edition is re-imported by hand. PRODUCT.md gains the edition object paragraph; the spine model gets an editions note.

**Unit B (send migration to Resend) — ship gates (owner-gated):**

- [ ] `RESEND_API_KEY` (+ audience id) added to `env.ts` as Worker secrets; the broadcast is created + sent **Worker-side** (the agent holds only its admin token).
- [ ] A live test broadcast to a seed audience (operator only) verifies DKIM/deliverability, the managed `RESEND_UNSUBSCRIBE_URL` + one-click `List-Unsubscribe`, and the LMX footer (unsubscribe link + postal address) **before** the list cutover.
- [ ] The Loops list is exported and imported to Resend **with unsubscribes preserved** (opt-outs never re-subscribed); `subscribeToNewsletter()` is repointed from Loops `contacts/create` to Resend `POST /contacts`; the web form + CLI + MCP + WebMCP subscribe paths all still work against Resend.
- [ ] The agent's send step swaps Loops-staging for a Resend broadcast (draft + the chosen send guardrail); the window cutoff moves into `editions.windowUntil`; the self-heal (last _sent_ edition anchors the next window) is preserved. **A sent edition mints its Log ID and records `sendProvider: "resend"` + `sendExternalId` + `sentAt`.**
- [ ] Loops is decommissioned from the send path (no dual-send); `docs/agents/newsletter-agent.md` reflects the Resend flow.

**Not a ship gate (honest scoping):** a Loops content back-import (one row, done by hand); a local `subscribers` mirror table (provider stays list-of-record unless Decision #7 flips it); a CLI `fluncle newsletter` reader (a thin, optional follow-on).

---

## Risks & open questions

- **Leaving a managed sender (the top real risk, B only).** A new sending identity warms from zero; a botched SPF/DKIM/DMARC setup tanks the first send. Mitigated by verifying DNS first + a seed-audience test broadcast before cutover; low volume warms gently. If the owner isn't comfortable, **A alone is a complete, valuable delivery** — the archive is the bulk of the value and carries no deliverability risk.
- **Owning unsubscribe/compliance correctly (B only).** Resend manages the mechanism, but we must include the token in every broadcast, carry the postal address in the footer (CAN-SPAM), and _never_ re-subscribe a Loops opt-out on import. The import step is the single most compliance-critical action; gate it.
- **The cap/tail mismatch (caught in grounding).** Editions are weekly; the mixtape's 54-cap tail would exhaust in ~a year. The tail shape is a real Decision (#4), not an afterthought — pick a tail that holds years before handoff.
- **The `/api/newsletter` naming collision (caught in grounding).** The subscribe POST already owns that path; the archive list must not clobber it. Resolved by Decision #5 (`/api/editions` for the object).
- **Loops has no content-export API.** Verified; there's no clean "pull past sent campaigns back." Mitigated by the tiny back-catalog (re-import by hand). If the back-catalog were large this would be a real project — it isn't.
- **The auto-send guardrail removes a human gate.** The manual Loops tap was an implicit review. Decision #8 keeps an explicit one (draft + one-tap/scheduled send) so publishing stays operator-controllable per PRODUCT.md.
- **Provider lock-in (deferred by choice).** Keeping the provider as list-of-record (Decision #7) means the _next_ migration is another vendor export, not a DB dump. Accepted: it matches today's posture and avoids owning subscriber PII; revisit only if it ever bites.
- **Scope honesty.** A is real and unblocked; B is honestly gated behind an owner call on a paid vendor + a domain-warm, not cut. The "build our own ESP on Cloudflare transactional sends" path is explicitly _not_ recommended — that would be the gold-plated wrong turn.

---

## Appendix — verifications & sources

**Live code verifications (against the worktree):**

- **The mixtape spine is the exact precedent:** Log ID mint math in `apps/web/src/lib/server/mixtape-log-id.ts` (`mixtapeTail`: `digit = floor((n-1)/6)+1`, `letter = "ABCDEF"[(n-1)%6]`; `mixtapeLogId` = `${sector(recordedAt)}.F.${tail}`); the atomic `next_sequence` mint CTE in `apps/web/src/lib/server/mixtapes.ts:435-452` (`publishMixtape`), the draft→distributing→published lifecycle + frozen coordinate (`updateMixtape:119-172`), and `MIXTAPE_SELECT:617` (externalUrls derived by subquery). The 54-cap (`publishMixtape:421-425`) is why the edition tail (weekly) needs a wider shape.
- **The universal resolver:** `apps/web/src/lib/server/log-resolver.ts` (`resolveLogPageTarget` branches on `isMixtapeLogId`); the pattern `/^\d{3,4}\.F\.\d[A-F]$/` in `apps/web/src/lib/log-id.ts`; the `/log/$logId.tsx` route renders `MixtapeLogPage` vs the finding flavor (`log.$logId.tsx`). The edition adds a sibling `isEditionLogId` + branch + `EditionLogPage`.
- **The fan-out precedents:** RSS UNION + `<category domain="…/ns/object-type">mixtape</category>` in `apps/web/src/routes/rss[.]xml.ts:33-64`; the `/mixtapes` index + `ItemList` JSON-LD in `mixtapes.index.tsx`; `MusicAlbum`/`DJMixAlbum` JSON-LD in `apps/web/src/lib/log-schema.ts` (the model for a `BlogPosting`); the llms.txt Mixtapes section in `apps/web/public/llms.txt`; the heterogeneous feed (`FeedItem = MixtapeDTO | TrackListItem` in `packages/contracts/src/index.ts`, merged in `tracks.ts` `mergeFeedPage`/`feedFindingsCount` — editions would be a third `FeedItem` arm if feed-included).
- **The current email/Loops surface:** `apps/web/src/lib/server/newsletter.ts` (`subscribeToNewsletter` → Loops `contacts/create` + transactional confirmation; `LOOPS_API_KEY`/`LOOPS_TRANSACTIONAL_ID`); the subscribe routes `api/newsletter.ts` + `api/v1/newsletter.ts` (the path the archive must not clobber); the CLI `apps/cli/src/commands/subscribe.ts`; the MCP tool `mcp.ts` `subscribe_newsletter` + WebMCP `webmcp.ts`; **no `subscribers` table** in `apps/web/src/db/schema.ts` (Loops is sole list-of-record). The admin pattern: `requireAdmin`/`requireOperator` in `env.ts` (two roles: operator + agent), `adminApiPost` in the CLI; the mixtape admin routes (`api/admin/mixtapes*`) as the endpoint template.
- **The signing-key posture is already split (no inherited prerequisite):** `ADMIN_SESSION_SECRET` (the admin-cookie/OAuth-state HMAC, `env.ts`) is **separate** from `FLUNCLE_API_TOKEN` (the Bearer), so this RFC adds no new box secret and inherits no signing-key fix.
- **The LMX email source:** `docs/agents/newsletter-template.lmx` (the `<Style>`, the "Ahoy cosmonauts," greeting, the `SLOT_*` word-slots, the "Happy raving, Fluncle" sign-off); the agent doctrine `docs/agents/newsletter-agent.md` (the window self-heal, "only sent campaigns anchor the window," the Loops-can't-send-by-API fact). The derived-public-surface precedent: `apps/web/src/routes/calendar[.]ics.ts` (a subscribable iCal built from mixtapes).
- **Canon:** the Email register (VOICE.md §5 / `packages/skills/copywriting-fluncle/references/voice.md`: "A letter from the uncle to the crew… Opens 'Ahoy cosmonauts,' closes 'Happy raving, Fluncle'"); **"the mothership"** = the newsletter + its list ("you board it by subscribing… it departs every Friday; Fresh bangers, every Friday, from Fluncle"); the mixtape `F` marker entry; the spine-model double-read.
- **The seed:** `docs/ROADMAP.md` — "Newsletter archive — bring the editions home… spine-native like a mixtape (a marked Log ID, a `/log/<id>` edition page, quiet feed/RSS inclusion)… persist that payload to the DB at draft/send time"; and the send-is-a-manual-tap line ("Loops has no programmatic campaign-send… dashboard-only").

**Vendor verifications (via Context7, dated 2026-06-21):**

- **Resend — full programmatic broadcast.** `POST /broadcasts` creates a broadcast to a `segment_id`/audience (optionally `send: true` or `scheduled_at`); `POST /broadcasts/{broadcast_id}/send` triggers it — with the constraint **"you can only send broadcasts that were originally created via the API."** Audiences/Segments + Contacts API (`POST /contacts`, `unsubscribed` flag); CSV import `POST /contacts/imports` with `column_map` + `on_conflict: upsert` + `topics` subscription. Managed unsubscribe via `{{{RESEND_UNSUBSCRIBE_URL}}}` in broadcast HTML; for bulk, Resend adds the RFC-8058 `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header. **Sends from Cloudflare Workers** (documented; plain HTTPS API, SDK or raw `fetch`). Webhooks `email.sent`/`email.bounced`/`email.complained` (the `sent` payload carries `broadcast_id`). Deliverability: SPF/DKIM/DMARC verification (Gmail/Yahoo 2024 bulk rules), in-dashboard deliverability insights; both sent + inbound count toward quotas. Source: Resend docs (broadcasts create/send, audiences/contacts, contact imports, send-with-cloudflare-workers, unsubscribe, account quotas) via Context7 `/websites/resend`, `/llmstxt/resend_llms_txt`. _Confirm current free-tier email/contact limits in-dashboard — they move._
- **Cloudflare Email Service — transactional-only today.** Its FAQ: **"Cloudflare Email Service is currently intended for transactional emails only. Support for marketing emails and bulk sender tooling is planned for the future."** The send API is a **single-recipient** Worker binding `env.EMAIL.send({ to, from, subject, html, text, headers })` (or REST `…/accounts/{id}/email/sending/send`); you may set `List-Unsubscribe`/`List-Unsubscribe-Post` headers yourself. **No audiences, no broadcast/campaign send, no suppression list, no managed unsubscribe** — running a newsletter on it means rolling our own subscriber table + suppression + unsubscribe + per-recipient loop. Source: Cloudflare Email Service docs (index, reference/headers, FAQ "Can I use this for marketing emails?") via Context7 `/websites/developers_cloudflare_email-service`.
- **Loops — no programmatic campaign-send (still true).** Confirmed against the agent doctrine + the ROADMAP (CLI/SDK/API/docs all dashboard-only for campaign send); the API is contact + transactional, and there is no documented sent-campaign content-export endpoint. This is exactly the blocker that motivates moving the send to Resend.
- **Others (weighed, not chosen):** Amazon SES + Postmark = strong transactional, but broadcast/audience management is not their managed strength (SES has none; Postmark Broadcasts is a separate, weaker product than Resend's for our need). Buttondown = newsletter-native with an archive + RSS, but it would duplicate the spine-native archive we're building on `fluncle.com` and add a second content home — wrong for an own-the-surface goal. Source: AWS SES / Postmark / Buttondown docs reviewed via Context7.

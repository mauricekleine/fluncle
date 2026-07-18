# RFC: Align the MCP and ChatDnB tool systems — one registry, two tiers

**Status:** Final (research → /taste → 3-role adversarial panel synthesized, 2026-07-18) — completeness standard applied.
**For:** a fresh build session or a small team of agents (5 ordered PRs, mostly parallelizable after PR-1).
**Canon/authority:** the codebase (`apps/web/src/lib/server/{mcp,chat,webmcp,search,fresh}.ts`), `DESIGN.md` (Unlit Rule §157), `VOICE.md` / the copywriting-fluncle voice canon (Found Rule; probe fiction), `docs/naming-conventions.md` (verb_noun), `docs/planning/ROADMAP.md` (the two ratified epics). This is planning, not spec.

> Process note: four divergent research threads (recon of both tool systems; shared-registry architecture; the two-tier taxonomy; sequencing/auth/naming/tests), a /taste pass, and a 3-role adversarial panel (staff engineer; canon/voice; product-scope/security). The reviewers found **real, load-bearing errors** — a factually-wrong security "leash," an oversold structural guarantee, an input-schema break, four stale model-facing strings — all baked in. One panel flag (the canon reviewer's "`build_set` must stay certified-only") was itself **overturned by the operator**: `/mix`, `build_set`'s web twin, is already catalogue-aware, so `build_set` surfaces catalogue too (Unit C). All handoff decisions are resolved (see "Decisions"). Live verifications in the appendix.

## The standard (definition of done)

Boil the ocean: every unit below ships **complete** — code + tests + docs, no thread left dangling. The 5-PR split is _ordering a complete delivery_, not a menu to cut from. Tests and the system-prompt/canon copy are part of "done," in the acceptance criteria, not a follow-up. **The one sanctioned "not now"** is retiring the external **Spotify** `search_tracks` on the _submit/write_ path (that is Epic 2, gated on the operator ratifying the submit-something-not-yet-crawled fallback) — and even that is honest scoping: Epic 1 delivers the entire read/chat two-tier experience with no dependency on it (verified live — see Appendix). Dangling threads this ties off: the silent MCP↔WebMCP↔ChatDnB drift, the `list_fresh` empty-in-chat bug (2026-07-18), the missing internal archive-search + catalogue browse on the MCP, and the **currently-unleashed sonic vector scan** (no abort timeout anywhere today).

## 0. Summary / the reframe

- **The drift is only in the tool _definitions_, not the data.** Both engines already call the same in-process server functions — `chat.ts:13` literally comments "the MCP is the hands." So the fix is **one `ToolDef` registry** that single-sources each tool's name + description + Zod input schema + canonical `execute`, adapted per transport. No data-layer change.
- **The register is carried by the output SHAPE — a distinct type, not an all-optional finding.** A finding carries a coordinate + note + observation; a catalogue row carries only name + artists + a Spotify link (a distinct `ChatCatalogueTrack`, mirroring the server's existing `CatalogueTrackItem`). Tools return two typed buckets — `{ findings, catalogue }` — rendered by a new unlit `CatalogueList` card. **This is not a new concept — it is copying the lit/unlit split the codebase already runs** (the server's `CatalogueTrackItem ⊥ TrackListItem`, the `/fresh` page, `/albums`/`/labels`/`/artist`, and the `search-command.tsx` unlit carrier). The type split makes "a catalogue row cannot render as a degraded finding" a compile-time guarantee and keeps catalogue rows out of `collectChatFindings`.
  - **Honest caveat (panel, load-bearing):** the type split prevents the model from _citing_ a coordinate/note/BPM it wasn't given. It does **not** by itself prevent _narration_ — narration ≠ citation. On chat (a free-prose surface, temp 0.4, Haiku, Fluncle's most-exposed voice) the model still holds `artists`/`title` and could write a reactive line _next to_ a correct card. So the "no narrative voice" rail on chat is **structural for citation, probabilistic for prose** — carried by the tightened prompt AND a red-team eval in the acceptance criteria (you cannot canon-review each live turn). On the MCP (a machine surface with no model prose) the rail stays structurally impossible to violate.
- **THE BIG REFRAME (verified live): Epic 1 has no Epic-2 read dependency.** The internal, catalogue-inclusive read search **already exists and is proven in production** — `searchArchive` is the one deliberate `LEFT JOIN` in the app (`search.ts:132`), returns rows tagged `certified: true/false` (`GET /api/v1/search/archive?q=netsky` returns both interleaved — Appendix). ChatDnB just discards the catalogue rows at the wire (`chat.ts:463`). Epic 1 ships the full two-tier experience — catalogue search + fresh + browse — with zero blockers. The only Epic-2-gated work is retiring the **Spotify** candidate search on the _submit_ path.
- **Decomposition (truly vs falsely coupled):** the _registry mechanism_ (PR-1), the _coverage_ gaps (PR-2/PR-3), the _register split_ canon change (PR-4), and the _catalogue browse_ tools (PR-5) are separable. Only PR-4/PR-5 depend on PR-1's registry; PR-2/PR-3 parallelize. No reorder is needed **provided PR-2 specifies the MCP `search_archive` projection returns both registers** (see Unit B) — otherwise a builder could ship a findings-only MCP search that PR-4 reworks.

## 1. Context & goals

**Why now.** The fresh-releases fan-out (2026-07-18) shipped `list_fresh` to both the bare MCP and ChatDnB — and a real Claude-app conversation showed it returning a full list on the MCP while ChatDnB returned empty, because ChatDnB filters `list_fresh` to certified findings and the current fresh window is all uncertified catalogue. Same name, two answers, because two hand-maintained tool sets assumed to be one.

**Goals (all in reach in Epic 1):** (1) one shared tool set, three transports, drift-proof by a build-fail **output-shape** test; (2) the two-tier taxonomy on both surfaces — lore/canon (findings, full voice) + catalogue (unlit register, listed never narrated); (3) the grounding boundary _evolves_ from "certified findings only" → "anything in the archive (findings OR catalogue), in the right register; never invents, never speaks from outside the archive."

**Out of scope (Epic 2, honestly deferred):** retiring the Spotify `search_tracks` submit-candidate path and collapsing `search_archive` → the canonical `search_tracks` name. `submit_track` already accepts a pasted Spotify URL directly (`mcp.ts:213`), so that fallback is nearly built — but the coverage decision is the operator's.

## 2. Unit A — the shared tool registry (PR-1, the foundation)

One module, `apps/web/src/lib/server/tools/registry.ts`. Zod v4 (`4.4.3`, a first-class `apps/web` dep — verified) is the schema source of truth.

**The `ToolDef` shape** (revised per panel — no free-form projection map, no speculative `needs`):

```ts
type Transport = "mcp" | "chat" | "webmcp";
type ToolTier = "lore-canon" | "catalogue" | "system";
type Projection = "publicRecord" | "compactCard" | "twoBucket" | "identity";

type ToolDef<In extends z.ZodType = z.ZodType> = {
  name: string; // verb_noun — the cross-surface identity
  title: string; // MCP `title`
  description: string; // shared, model-facing (see Unit C for the register wording)
  input: In; // Zod v4 — the ONE canonical schema (but see the input-divergence decision)
  tier: ToolTier; // grounding class
  access: "public" | "session"; // AUTHORED INDEPENDENTLY of `transports` (security fix — see below)
  effect: "read" | "write"; // writes receive `ctx.request`; derived, no separate `needs` field
  transports: Transport[]; // where it may appear
  project: Partial<Record<Transport, Projection>>; // a CLOSED set, not a free function
  execute: (
    args: z.infer<In>,
    ctx: { request?: Request; signal?: AbortSignal },
  ) => Promise<unknown>;
};
```

**Why a closed `Projection` set, not a free `present` function (taste + staff-eng).** The overlapping tools _intentionally_ diverge in output — the MCP world-serves the fuller public record (`publicFindingRecord`), ChatDnB serves the compact card + the grounding/Unlit split (`compactFinding` → `{findings, catalogue}`). A free-form per-tool projection function would **re-open the very drift door the registry exists to close** (arbitrary per-tool per-transport output) _and_ collapse the AI-SDK output typing to `unknown`. Instead, a tool declares one of a **closed, named, reviewable set** of projections — `publicRecord` (MCP full), `compactCard` (chat lore/canon), `twoBucket` (chat catalogue-split), `identity` (status). Each named projection is a single typed function in the registry, applied by the adapter. Symmetry, and divergence is constrained to four sanctioned shapes.

**The three adapters:**

- `toMcpTool(def)` → `z.toJSONSchema(def.input, { target: "draft-2020-12", io: "input", unrepresentable: "any" })`. **Pinned gotchas:** (a) `z.toJSONSchema` defaults to `unrepresentable: "throw"` — pass `"any"` so a future exotic type degrades to `{}` rather than throwing the whole `tools/list`; (b) the explicit-opts form does **not** emit `"additionalProperties": false` that the no-opts default emits — deliberate (open objects), but state it; (c) the adapter **must bridge the positional `(args, request)` signature the dispatcher calls to `execute(args, ctx)`** (`ctx.request = request`). The dispatcher, `toolResult`, resources, prompts, and the live-set note stay untouched in `mcp.ts`.
- `toAiSdkTool(def)` → pass the **Zod object straight through** to `ai@7.0.19`'s `tool({ inputSchema: def.input, execute })` (verified the current `chat.ts` shape). Do NOT route chat through JSON Schema — it erases the `z.infer` arg typing. AI SDK v7 `execute` gets `(args, { abortSignal, … })` → map `abortSignal` to `ctx.signal`. (Output stays `unknown`-cast at the card boundary, the status quo — `renderFindingOutput` already casts; the closed projection set is where output shape is controlled.)
- `toWebMcpTool(def, httpExecute)` → shares `name` + `description` + JSON Schema; keeps its hand-written `fetch('/api/…')` execute (browser has no in-process fns / `Request`).

**Migration (least churn):** seed with the 5 overlapping tools (`get_track`, `get_random_track`, `get_status`, `list_fresh`, `list_tracks`), each declaring its `project` per transport lifted from today's code, then `mcp.ts`/`chat.ts`/`webmcp.ts` spread `SHARED_TOOLS.filter(t => t.transports.includes(<x>)).map(to<X>Tool)` alongside their transport-only extras.

**PR-1 is NOT input-schema-behavior-preserving (staff-eng, must-decide).** The three transports disagree on input schemas today — `get_track` names its arg `idOrLogId` on MCP/WebMCP but `coordinate` in chat; `list_fresh` caps at 100 on MCP/WebMCP but 48 in chat; `list_tracks` is `number` (MCP) vs `integer` (chat). Unifying forces a choice. **Resolved (operator):** canonical `idOrLogId` (rename chat's `coordinate` — 0 current consumers, so no break), `list_fresh` cap = 100, `list_tracks` = `integer`.

**The MCP `.parse()` change eats tolerant clamping (staff-eng, per-tool).** MCP does not validate args today — the limit tools _clamp_ (`clampLimit`, `mcp.ts:901`), so `limit: 100` works and `limit: "10"` falls to a default. A bare `z…max(48).parse()` would **throw** on both. For the clamping tools, the shared schema must preserve clamp semantics (`.catch()`/`.default()` in the Zod schema, or `.safeParse` + fall back to the clamp) — not a blanket strict parse. Land per-tool, with a test.

**Stays per-transport (do NOT unify):** auth gates; the result envelope (MCP `{content:[…], isError}` + live note vs the AI SDK streamed tool part); streaming vs single-shot; the MCP-only resources (`fluncle://…`) and prompts.

## 3. Unit B — tool coverage + the auth model (PR-2 reads onto MCP; PR-3 writes onto ChatDnB)

**PR-2 — add the internal read tools to the MCP + WebMCP:** `search_archive`, `get_artist`, `get_label`, `build_set`, **and a brand-new `get_similar_artists`** (operator addition, 2026-07-18 — the related-artist discovery a real user asked for). This finally gives the MCP a real **archive** search (its `search_tracks` searches Spotify, not Fluncle). WebMCP's `search_archive` calls the existing **public** `GET /api/v1/search/archive` HTTP endpoint (confirmed public + live — Appendix); `get_artist`/`get_label` call their public `/api/v1/artists|labels/:slug` routes.

- **`get_similar_artists` (new tool, both engines, and the discovery win).** Given an artist name or slug, return the sonically-nearest artists — the MuQ-embedding "Similar artists" the `/artist/<slug>` page already renders. The backing read exists: `getArtistNeighbours(artistId, limit)` in `apps/web/src/lib/server/artist-dossier.ts` → `ArtistNeighbour[]` = `{ name, slug, imageUrl? }`. The tool resolves name→slug→id the way `get_artist` does, then calls it. **REUSE `getArtistNeighbours` — never invent a second similarity path.** The tool is a thin pass-through of that one read. A SEPARATE, parallel operator workstream is widening the read (do NOT touch the neighbour mechanism in this PR): today the rail covers only certified, embedded findings (`log_id is not null and embedding_blob is not null` — a catalogue-only artist like Koven gets no rail); the recorded next steps are (a) widening the pool to any embedded track (pulling the crawled frontier in as unlit neighbours) and (b) a precomputed `artist_similar`/centroid table (sweep-shaped like `rank_catalogue`, the moment both surfaces get one read). Because `get_similar_artists` stays a pass-through, it inherits both for free; if `ArtistNeighbour` later gains a `certified`/register field, pass it through unchanged. **Tier: lore-canon** — it returns named artist ENTITIES (each has an `/artist/<slug>` page), and naming an artist is always allowed (the Unlit Rule silences uncertified _tracks_, never artists); a neighbour may be a findings artist or a catalogue-only artist, both nameable. Naming: `get_similar_artists` — the artist-level twin of the existing `get_similar_findings` (track-level). **WebMCP caveat:** neighbours are not yet on a public HTTP op (only the artist-page loader), so WebMCP either gets a thin public `GET /api/v1/artists/:slug/similar` endpoint in this PR (recommended — small, and it lights up the browser mirror + any external client) or omits `get_similar_artists` like it omits `get_status`. MCP + ChatDnB call `getArtistNeighbours` in-process, no endpoint needed.

- **`search_archive`'s MCP projection returns BOTH registers, certified-tagged** (`publicRecord` over the full `SearchResult`, exactly like the MCP's `list_fresh` world-serves uncertified rows today) — **never** the chat's findings-only filter. Stating this here is what removes any PR-4↔PR-2 ordering coupling.
- **🔴 MANDATORY — the MCP `search_archive` execute MUST rate-limit (security, verified live, NOT a "decision").** The anonymous `/mcp` has zero auth and zero rate limiting; the existing public HTTP twin _deliberately_ wraps `searchArchive` in `assertRateLimit({ action: "search_archive", limit: 30, windowMs: 60_000 })` keyed on `hash(cf-connecting-ip)` (`orpc/search.ts:119`) precisely because its tier-4 LLM path spends real money. The MCP execute receives `request`, so it MUST call `assertRateLimit` with the **same `action: "search_archive"` budget**, so both public surfaces share one per-IP limiter. **Additionally**, put an `AbortSignal.timeout` on the sonic `runSonic` `db.execute` — there is none today; the scan ran **8.07s** on prod over ~41k rows and grows with the catalogue (Appendix). (This bounds a real, product-wide gap, not just the MCP.) The RFC's earlier "3-second leash" was **wrong** — that timeout is on the LLM-translation tier only; the vector scan is unabortable today.

**PR-3 — add the write tools to ChatDnB:** `submit_track`, `subscribe_newsletter` (`access: "public"`), running under ChatDnB's gated route (session + verified-email + CSRF + dual rate dials) — strictly safer than the anonymous MCP already exposes them. Add a system-prompt line so Fluncle can take a submission mid-conversation.

**The auth model (security fix — a real cross-field check, not a tautology).** `transports` is authored **independently** of `access`. Each transport projects by its transport list; the build-fail auth test then asserts the **realized MCP tool set** (what `toMcpTool` actually emits) contains **no `access: "session"` tool**. (Projecting on `access === "public" && transports.includes("mcp")` would make "no session tool on MCP" a vacuous tautology — the danger it must catch is a genuinely-privileged _future_ tool mislabeled `access: "public"`, which a consistency check can't see; so add a review rule: **any tool that mutates user-owned state is `access: "session"`**, enforced in review + a lint of the registry.) ChatDnB projection = public ∪ session tools (its gate is a superset). WebMCP = public tools whose action has a public `/api/*` endpoint.

## 4. Unit C — the register split (PR-4, the heart; the grounding-boundary evolution)

Today ChatDnB discards `certified: false` rows at the wire. PR-4 stops discarding them **in exactly two tools** and surfaces them in the unlit register.

**All THREE list-returning tools split — `search_archive`, `list_fresh`, AND `build_set` — because `build_set` is the chat twin of `/mix`, which is already catalogue-aware (operator correction, 2026-07-18; the panel's canon reviewer got this wrong).** The `/mix` rail runs `MIX_FROM = tracks left join findings` (`tracks.ts:1251`) — "an uncertified track competes on exactly the same terms as a finding" (`tracks.ts:1247`) — and its `MixTrack` DTO already encodes the Unlit Rule in three lines (`tracks.ts:1281`: `certified` flag, `logId` present iff certified). The `?set=` handoff carries catalogue too: the shared `setToken(track: { logId?: string; trackId: string })` (`mix-set.ts`) uses the `trackId` when there is no coordinate. And the step `reason` ("Same key", "tempo locked") is a **mixability measurement** (a chip), not editorial narration — measurement is explicitly allowed on uncertified tracks (the certification rail: measure yes, speak no). So the canon reviewer's premise ("a mix chain is lit by construction, the tokens are certified Log IDs") is false against the live `/mix`. **The fix:** `build_set` drops its `candidate.certified && candidate.logId` filter (`chat.ts:219`) to match `/mix` — it chains BOTH registers, catalogue steps riding in the unlit mix register (bpm/key + a mixability reason chip, `trackId` token, NO coordinate/note/observation, never narrated). It returns the existing `set` shape rendered by `ChainCard` (which shows chips, not free prose per step — so no narration surface is added; it stays exactly as canon-safe as `/mix` is today). Regression test: `build_set` chains catalogue candidates in the unlit register (bpm/key/reason, no coordinate), matching `/mix`.

**The output contract:**

```ts
type ChatCatalogueTrack = {          // mirror of the server's CatalogueTrackItem
  artists: string[]; title: string; spotifyUrl?: string;
  release?: string; label?: string; // context; never per-track lit data
};                                   // NO coordinate/note/observation/cover/galaxy/bpm/key/hasPreview
// search_archive + list_fresh return:
{ findings: ChatFinding[], catalogue: ChatCatalogueTrack[], ok: true }
```

- **`list_fresh` fixed:** map the already-tagged `certified === false` rows (`listFreshTracks` already returns them cover/coordinate-free — `fresh.ts:328`, verified) into `catalogue`, keep certified rows hydrated into `findings`. **No new server read.** Directly fixes the empty-in-chat bug.
- **`search_archive` dual:** split `result.results` by `certified` into the two buckets **before returning** — the sonic tier (`search.ts:659`) has no certified-first break, so register must be decided by field-presence, never list position.

**The `CatalogueList` card + the render fix (canon reviewer — a real bug).** `renderFindingOutput` (`chat-conversation.tsx:287`) returns on the **first** matching branch, so a naive "branch `CatalogueList` before the findings case" would **hide the findings**. Instead, for a `{findings, catalogue}` output, render **both** in one block — `FindingList` first, then the catalogue block — mirroring `search-command.tsx:454-467` verbatim. Card spec: Dust-Veil, no gold/cover/coordinate/play control, **outbound Spotify link only**, the distinct `ChatCatalogueTrack` type (keeps it out of `collectChatFindings` — verified: that walker keys only off `finding`/`anchor`/`findings`/`set`/entity, never a `catalogue` key).

- **Heading (Unlit Rule):** a **mixed** result (findings above) may head the catalogue block with the true superset **"Tracks"** (as `search-command.tsx` does, gated on `findings.length > 0` via `headUnlit`); a **catalogue-only** answer (browse tools, an all-uncertified `list_fresh`) stays **bare/unheaded**. **Not** "Also out there" — that names the tier by its defining property (true only of the uncertified subset) and teaches the tier, which the Unlit Rule forbids. Any tier framing lives in Fluncle's **prose**, never card chrome.

**The grounding boundary evolves (system prompt + FOUR stale strings — canon reviewer, exact wording).** Revising only `chat.ts:108-109` leaves four other model-facing strings false. Ship all of these:

- Replace `chat.ts:109` ("You only ever speak about your certified findings…"):
  > Two kinds of thing come back from your tools. A finding is a track you certified: it carries a Log ID coordinate, and you speak about it in full — what it did to you, where it sits, all of it. A catalogue row is a record you know is out there but have never certified: it carries a name and its artists and nothing else. You may name it and list it when someone asks what is out there — that is all. You never react to it, never say what it does to you, never give it a coordinate, never mix from it, and never say you found it or logged it. No coordinate in the result means it is not a finding. Never invent a catalogue row either — if a dig or a browse comes back empty, say so plain and stop.
- Fix `chat.ts:111` (`list_fresh` prose): "…the ones you certified you speak about as just dropped; the ones you have not certified you only name and list, never as found."
- Fix the tool `description`s the model reads — `chat.ts:456` (`search_archive`): "Returns two registers: certified findings (spoken in full) and catalogue rows he knows are out there but has not certified (named and listed only, never narrated). An empty result means nothing in the archive matched." — and `chat.ts:400` (`list_fresh`): "…his certified findings that released in the trailing month, plus catalogue rows that released but he has not certified — those are listed, never spoken as found."
- **Body-scoping carve-out:** the prompt's "react like a body… lead with what a tune did to you" (`chat.ts:116`) must be explicitly scoped to findings, or the model applies body-voice to whatever it names.
- **Empty-state rewrite (Flat Copy Test — "the crawl has not reached there" puts machinery in Fluncle's mouth):** "Nothing came back from that sector — haven't been out that far yet." (or for an empty name/label browse: "Haven't flown out that far. Nothing of mine, nothing on the shelf either."). Run the final pick through `copywriting-fluncle`.

**Canon gate:** PR-4 MUST run the `copywriting-fluncle` skill on all new copy + a `canon-reviewer` Flat-Copy pass, AND add a **red-team eval** to the acceptance criteria (design-time canon-review cannot run per turn) — a small prompt set ("list everything out on <uncrawled label>") asserting no first-person reaction verbs land on catalogue rows.

## 5. Unit D — catalogue browse tools (PR-5)

Three internal read tools (both transports), each resolving a name to a slug then calling an existing anti-join read (all verified to return the lit-field-free `CatalogueTrackItem`): `list_album_catalogue` → `listCatalogueTracksByAlbum` (`tracks.ts:780`); `list_artist_catalogue` → `listArtistCatalogue` (`catalogue-groups.ts:245`); `list_label_catalogue` → `listLabelCatalogue` (`catalogue-groups.ts:346`). Catalogue bucket only (uncertified discography by construction), `CatalogueList` card, bare/unheaded. No Spotify.

## Sequencing & ownership

- **PR-1 (registry foundation)** first — behavior-preserving for _output_ (input-schema decisions per Decision 2), with the output-shape + snapshot tests. The zero-decision unblock and the biggest de-risk (later PRs become registry edits, not three-file surgery).
- **PR-2 (reads→MCP + the mandatory rate-limit)** and **PR-3 (writes→ChatDnB)** parallelize after PR-1 — disjoint tool sets. PR-2 carries the security requirement and states the both-registers MCP projection, so no PR-4 coupling.
- **PR-4 (register split)** — the critical path and canon-heavy; depends on PR-1; runs parallel to PR-2/PR-3.
- **PR-5 (browse tools)** — depends on PR-4's `catalogue` bucket + card; ships last.
- Deploy discipline: space the merges; PR-4/PR-5 both touch `chat.ts` + the chat components — sequence them.

## Decisions — RESOLVED by the operator (2026-07-18)

1. **`build` verb** → **add `build` to the closed `APPROVED_VERBS` set** with a documented reason (the `anchor`/`drip`/`certify` pattern). (Recommendation ratified by keeping `build_set`.)
2. **Input-schema unification** → **`list_fresh` cap = 100** everywhere; **`get_track` = canonical `idOrLogId`** — with **0 current consumers** the simplest path is to rename chat's `coordinate` arg to `idOrLogId` (an alias is optional insurance, not required). No breaking-change risk.
3. **`search_archive` name** → keep `search_archive` through Epic 1; **collapse to `search_tracks` in Epic 2** when the Spotify tool retires. Ratified.
4. **Writes in ChatDnB** → **yes**, `submit_track` + `subscribe_newsletter` are ChatDnB tools (gated-session-safe).
5. **Catalogue register loudness** → **a bare list.** Fluncle names and lists catalogue rows with no surrounding "here's what's out there" prose framing; the list stands alone (the copy for the empty-state + any lead-in still goes through `copywriting-fluncle`, but the default is bare).

_All decisions resolved — the RFC is ready to hand to a build session._

## Acceptance criteria

- One `SHARED_TOOLS` registry; `mcp.ts`/`chat.ts`/`webmcp.ts` each project from it; no hand-maintained duplicate tool list.
- **Output-shape regression test (the real guard):** `list_fresh` and `search_archive` return `{findings, catalogue}` in chat; a catalogue row carries none of `{coordinate, note, observation, cover, hasPreview, bpm, key}`; a certified row rides as a finding. This — not tool-name parity — is what guards the class of bug that started the epic.
- **Tool-set parity test:** each transport's set equals its declared projection, with the codified asymmetries allow-listed: `get_status` off WebMCP, resources/prompts server-MCP-only, **and the `get_recent_tracks` deprecation alias present on MCP/WebMCP but not chat**.
- **Auth cross-field test:** the realized MCP tool set contains no `access: "session"` tool; a registry lint that any state-mutating tool is `access: "session"`.
- **Rate-limit test:** the MCP `search_archive` execute calls `assertRateLimit({ action: "search_archive", … })`; a sonic query carries an abort timeout.
- **Schema snapshot test:** each tool's `z.toJSONSchema` output snapshot carries its `required`/min/max (guards a zod-version bump silently changing output) — a snapshot, not a self-comparison.
- **Naming test** over the registry tool names (verb_noun + `APPROVED_VERBS` incl. `build`); **`build_set` chains catalogue candidates in the unlit mix register** (bpm/key/reason chip, `trackId` token, no coordinate/note), matching `/mix` (regression).
- **Grounding invariants** on both transports: `previewUrl`/expiring tokens and the private capture key never leak.
- **Red-team canon eval** (PR-4): the uncrawled-label prompt set asserts no narration verbs on catalogue rows.
- Docs: `docs/surfaces-doctrine.md` `mcp.server` exposedContent; the naming closed-verb set; the ROADMAP epic flipped to "Epic 1 has no Epic-2 read dependency."
- Canon: PR-4 passes `canon-reviewer` (Flat Copy Test) on all new copy.

## Risks & open questions

- **🔴 The anonymous MCP's new reach.** `search_archive` on `/mcp` is a cost/DoS path (8s unleashed vector scan + a real-money LLM tier) — **mitigated only by the mandatory shared `assertRateLimit` + the sonic abort timeout in PR-2.** The earlier "leash" claim was retracted as factually wrong.
- **Prose leakage** (narration ≠ citation) — the residual the note-less shape can't catch on chat; carried by the tightened prompt + the red-team eval, and honestly probabilistic, not structural.
- **`build_set` register** — resolved: it mirrors `/mix` and chains catalogue in the unlit register (the panel's "certified-only" was wrong; `/mix` is already catalogue-aware, and `ChainCard` shows chips not prose, so no narration surface is added).
- **Input-schema break** (`get_track` arg rename) — mitigated by the `coordinate` alias (Decision 2).
- **The `.parse()` clamp regression** — per-tool clamp-preserving schemas, not a blanket strict parse.
- **The render either/or bug** — `{findings, catalogue}` must render both buckets, heading gated on `findings.length > 0`.

## Appendix — verifications & sources

- **Zod→JSON-Schema bridge works (staff-eng, ran live):** `node_modules/zod` = **4.4.3**, `node_modules/ai` = **7.0.19**; `z.toJSONSchema` converts all five current tool schemas clean (e.g. `list_fresh` → `{type:object, properties:{limit:{type:integer,minimum:1,maximum:48}}}`); no enums/unions/coerce/transform in the live set. `draft-2020-12` matches MCP protocol `2025-06-18` (`mcp.ts:38`). Explicit opts omit `additionalProperties:false`.
- **`searchArchive` catalogue-inclusive (security, live):** `GET https://www.fluncle.com/api/v1/search/archive?q=netsky` returns certified findings interleaved with `certified:false, logId:null` catalogue rows. Code: `search.ts:132` (LEFT join), `:160` (`certified` from `log_id`), `:140` (`CERTIFIED_FIRST`), `:659` (sonic no certified-first).
- **The unleashed sonic scan (security, measured live):** a "sounds like…" query returned in **8.07s** (`kind: sonic`) over ~41k rows; `runSonic` (`search.ts:667`) issues its `vector_distance_cos` with no signal/timeout/abort. The `3_000ms` timeout (`search-llm.ts:44`) is on the LLM-translation tier only.
- **The existing rate-limit twin:** `orpc/search.ts:119` — `assertRateLimit({ action: "search_archive", limit: 30, windowMs: 60_000 })`, IP-keyed, with the "spending real money" comment. The anonymous `/mcp` (`server.ts:45`, `mcp.ts:596`) has none.
- **`build` absent from `APPROVED_VERBS`:** `orpc-naming.test.ts:36` (keyed on contract-op names today; the new registry test brings tool names under it).
- **`list_fresh` two-register data already present:** `fresh.ts:328` (uncertified rows cover/coordinate-free), type at `:273`. Both engines call the same in-process fns: `chat.ts:13`.

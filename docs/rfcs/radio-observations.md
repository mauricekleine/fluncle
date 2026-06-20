# RFC: Audio observation layer + radio.fluncle.com — a third enrichment artifact, then a station that plays it

**Status:** Final (research → /taste → 4-role adversarial panel synthesized, 2026-06-20) — completeness standard applied.
**For:** a fresh build session (or a small team of agents) standing up the observation pipeline + the radio surface, plus Maurice for the ElevenLabs voice-ID + paid-vendor + canon calls.
**Canon/authority:** the codebase and `AGENTS.md` arbitrate; `docs/track-lifecycle.md`, `docs/rfcs/hermes-agent.md`, `VOICE.md` / `packages/skills/copywriting-fluncle`, `packages/video/README.md`, and the live `fluncle` CLI + `/api/v1` are the ground truth. This is planning under `docs/`, not spec. The source `docs/rfcs/radio-brief.md` is a non-canonical brainstorm (per `AGENTS.md`) — the direction is right, the specifics are corrected here.

> Process note: divergent research across five threads (the enrichment data model + queue; the R2/CLI/admin-endpoint pattern + command-gate class; the voice + script artifact; the `/api/v1` + radio host-rewrite + DTO + UI; and the ElevenLabs/firecrawl vendor surface — each grounded in the real worktree files and, for the vendors, in current docs dated June 2026), then a /taste pass and a 4-role adversarial review (staff engineer, brand-voice director, security/ops, product-scope). Their corrections are baked in — including the brief's three load-bearing errors: `note` is **not** unused (it is the operator-authored editorial "why" with public SEO/AEO value), the sample script uses **banned identity words** ("signal"), and the "Start transmission" gate copy uses another (**"transmission"**). Live verifications and sources are in the appendix.

---

## The standard (definition of done)

Every unit ships complete — schema migrated, secrets handled per the token-only invariant, voice gated, surfaced, documented. No demo-with-a-TODO. Specifically:

- **Nothing is deferred or optional within a chosen unit.** The observation pipeline ships with: the `context_note` + `TrackObservation` columns (a generated drizzle migration), the `/api/admin/tracks/:id/observe` endpoint, the `fluncle admin track observe` CLI command, the firecrawl context-fetch and ElevenLabs render both **Worker-side**, the presigned-PUT upload of `observation.mp3`, the script routed through the **voice gate**, the `TrackObservation` fields on the public DTO, and a `docs/agents/observation-agent.md` operating doc. The radio unit ships with the host-rewrite, the `/radio` route, the `/api/v1/radio/random` endpoint, the cycle loop with broken-asset skip, and the in-voice gate copy. A pipeline that renders audio but exposes no DTO field, or a radio page with off-canon copy, is not done.
- **Tests + docs are part of done.** New server code (the `observe` endpoint, the `context_note`/observation fields on the update allow-list, the radio-eligibility query filter, the `/api/v1/radio/random` route) ships with unit tests in `apps/web` + `apps/cli`, mirroring the existing `r2-presign.test.ts` / `tracks-search.test.ts` / `track-stage.test.ts` shape, per `AGENTS.md`.
- **The only sanctioned "not now"** is a genuine external-dependency chain: (1) **the bespoke Fluncle voice** depends on Maurice producing an `ELEVENLABS_VOICE_ID` (a recording + consent step) — the pipeline is built and tested against a stock library voiceId and the bespoke voice dropped in by swapping one secret, so this gates the _final voice_, not the build; (2) **landscape radio** depends on a landscape render the `packages/video` kit doesn't emit today (it produces 1080×1920 only) — honestly scoped out behind that real blocker, with portrait letterboxed in the meantime; (3) **the autonomous agent that runs `observe` unattended** is the Hermes RFC's box — until it exists, `observe` runs by hand (locally) exactly like video + publish do today (`docs/agents/enrichment-agent.md`), and the pipeline is complete regardless.
- **Two hard prerequisites this work inherits (state them, don't bury them).** (a) **The admin-cookie signing-key split** the Hermes RFC specs: `FLUNCLE_API_TOKEN` is _both_ the API Bearer _and_ the admin-cookie HMAC signing key (`env.ts` `signState`/`verifySignedState` — verified), so a box leak forges web-admin sessions. This RFC adds **no new secret to the box** (the invariant holds), but it ships an _agent-pollable_ command, so it inherits the Hermes posture — the signing-key split should land in parallel, not after. (b) **`copywriting-fluncle` must be loadable wherever the script is authored** — the voice gate is hollow without it (the Hermes RFC flags the same porting caveat). Both are tracked as Decisions, not assumed.
- **Tie off dangling threads in reach.** This work reuses (and therefore depends on shipping) **the enrich-queue status-filter slice the Hermes RFC already specs** — `ListTracksOptions.status` + the `filterClauses` clause in `listTracks` (`tracks.ts`). The observation queue is that same machinery with two more predicates. If the Hermes slice hasn't landed when this does, this RFC ships the slice (it is small and shared); they must not both invent it — confirm ownership before building (Decision #11).

---

## 0. Summary / the reframe

- **The unifying simplification: the audio observation is a third enrichment artifact that rides the rails the video bundle already runs on.** Everything the brief asks for reduces to _"do for audio what the pipeline already does for the video."_ Same R2 convention (`found.fluncle.com/<log-id>/<name>` — `media.ts` is the single source of that convention), same direct-`put` for a small artifact the Worker already holds (`env.VIDEOS.put` — the exact pattern `tracks.$trackId.video.ts` uses for sub-100MB uploads; the presigned-PUT path is only for the ~99MB video cuts the CLI streams), same generic admin write-back (the `TrackUpdate` allow-list in `track-update.ts`), and the radio subdomain is the **same isomorphic host-rewrite as `galaxy.fluncle.com`** (a 4-line addition to `router.tsx`). There is almost **no new architecture** — there is a new vendor (ElevenLabs), three new columns, two new routes, and one new page. The discipline is making each piece _look like the video pipeline_, not inventing a parallel one. (Two grounded caveats the panel caught, both spec'd below: the random-track query is **its own bare SQL** — `getRandomTrack()` takes no options today — not the `listTracks`/`filterClauses` builder, so the radio filter extends _that_ function, §6; and the enrich-queue _status_ slice is a real shared prerequisite, not free, §-Sequencing.)
- **The locked architectural decision is the right one, and it's already the house pattern.** Firecrawl search **and** ElevenLabs TTS run as **authenticated admin API endpoints inside the Worker** (`apps/web`), so `FIRECRAWL_API_KEY` (already a declared secret — `env.ts:13`), the new `ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID`, and R2 creds all stay Worker-side. The only secret any agent box holds stays `FLUNCLE_API_TOKEN`. The agent's whole role is **poll the queue → `fluncle admin track observe <id>` → the Worker fulfills it.** This is strictly the Hermes RFC's model; the alternative (an authed ElevenLabs/firecrawl CLI on the agent box) co-locates more secrets with the token — the exact §4 anti-pattern. Verified feasible: a ~30s render is ~0.5 MB, fits the Worker's 128 MB memory, and a `fetch` _await_ doesn't burn Worker CPU. The **one** thing the Worker can't do is ffmpeg loudness-normalization — addressed below as optional polish, not a blocker.
- **The brief's data-model claim is wrong and must be inverted.** `note` is **not** "the existing unused note field." It is the operator-authored editorial **"why I logged this"** that renders on `/log/<id>` and feeds the `MusicRecording` JSON-LD (public SEO/AEO value), and the ROADMAP has an "Auto-drafted finding notes" item gated on a notes corpus. The firecrawl-derived _factual context_ is a different thing — internal creative fuel, never public copy. **Decision: a new private `context_note` column, not an overload of `note`.** (§2.)
- **Two artifacts, not one.** The `context_note` is dry facts (label/year/release context — firecrawl output). The **observation script** is a separate Fluncle-voice artifact written _from_ those facts — it adds emphasis, emotion, and TTS direction. They live in different places (a DB column vs `observation.txt`/`observation.json` on R2) and pass different gates (no gate vs the **voice gate**). **The script is authored by the agent** (which holds `copywriting-fluncle`), not by an in-Worker LLM — the Worker mechanically scans it and relays it to ElevenLabs. This is a _decision_, not an open choice (§3, §4; Decision #7).
- **`observe` is auto-allowed for _publishing_, but it spends money and reads untrusted web content — so it carries two non-publish guards.** Structurally it is like the analysis-scoped `track update`: it writes an internal R2 artifact (`observation.mp3`, audible publicly only once the operator stands up radio) + a private field (`context_note`) + enrichment fields, and posts to **no** public social surface — so it runs autonomously through the command gate, not behind a human confirm. But the security panel was right that "structurally safe to publish" ≠ "free to call": each call **costs an ElevenLabs render**, and firecrawl **browses untrusted pages** into the script LLM's input. So auto-allowed comes with an **idempotency key** (`observe:${logId}` — one render per track, not per poll) and an **untrusted-input boundary** (a firecrawl domain allow-list + lyric-marker drop + the voice gate scanning _output_). (§5.)
- **Decomposition (truly-coupled vs falsely-coupled vs falsely-bundled):**
  - **Unit A — the observation pipeline** (schema → `observe` endpoint+CLI → firecrawl → script+voice-gate → ElevenLabs → R2 → DTO). The headline. Self-contained; ships and is useful (a per-track narrated artifact) **before any radio page exists**.
  - **Unit A′ — the observation's first home is the existing `/log/<id>` page** (a single dark, quiet `<audio>` control under the footage), _not_ a new subdomain. This is the panel's strongest reframe: the observation is a per-track artifact whose natural home is the archival-plate page it already belongs to. Surfacing it there is one component + one DTO field — **and it is where the brand bet gets falsified cheaply** (hear three observations on the page they live on, before building anything to amplify them). It ships _between_ the pipeline and the radio page.
  - **Unit B — `radio.fluncle.com`** (host-rewrite → `/radio` page → `/api/v1/radio/random` → cycle loop). The **amplification** surface, not the point — a read surface over artifacts Unit A mints, built **only after** the `/log` observations clear the North Star. A radio station amplifies good observations _and bad ones_; earn the subdomain by having something worth a station.
  - **Shared dependency (not new here) — the enrich-queue status slice** from the Hermes RFC. Both this and Hermes need it; whichever ships first builds it (confirm ownership first — Decision #11).
  - **Falsely-coupled — landscape render.** A `packages/video` capability (the kit emits portrait only), parked behind the kit-delivery question the ROADMAP already tracks. Scoped out; portrait letterboxes in the meantime.
  - **Falsely-bundled — "the audio agent is a new separate process."** The brief frames a standalone audio agent. It isn't a new runtime; it's one more step the **same** enrich-agent runs (`docs/agents/enrichment-agent.md` already chains enrich → video → publish; observe slots in after video), or one more thing the Hermes box polls for. No new box, no new harness.
- **The honest horizon.** Unit A is in reach now (schema + two routes + a CLI command + a vendor call), gated only on the new secrets and — for the _bespoke_ voice — Maurice's voice-ID setup (a library voice unblocks the build immediately). Unit A′ (`/log` audio) is a same-week follow-on and the cheapest falsifier of the whole bet. Unit B (radio) is in reach once the `/log` observations clear the North Star. Landscape is out of reach until the kit emits it. The autonomous-unattended version waits on the Hermes box; until then `observe` is a hand-run step, and that's complete.

---

## 1. Context & goals

**Why now — and the honest case.** A track's life already fans out across ~10 surfaces under one Log ID (`docs/track-lifecycle.md`). The observation layer adds a genuinely new _kind_ of artifact: a spoken, in-voice **field observation** — what Fluncle saw and felt approaching the coordinate — that the existing pipeline has no analogue for. It's the first Fluncle output that is _heard_, not read or watched. The radio page then becomes a low-effort, always-fresh surface that plays those observations over the silent footage: a "continuous stream of Fluncle's findings" that streams **zero commercial audio** (the observation voice over the audio-less video), so it carries no licensing exposure — a real product affordance the archive doesn't have today.

- **The case to weigh (take it seriously):** this introduces a paid vendor (ElevenLabs) and a brand-critical _spoken_ surface — the hardest voice surface to get right, because a wrong word is _heard_ in a synthetic voice and can't be skimmed past. The cost of an off-voice observation is higher than an off-voice tweet. The voice gate (§3) is therefore non-negotiable, and the bespoke-voice setup is real work for Maurice. If the observations don't clear the North Star ("would the uncle say this out loud over a tune?"), the feature is a net negative for the brand. That's why Unit A ships and is judged on _quality of a few observations_ before Unit B (the page that amplifies them) is built.
- **The case for:** it deepens the existing two-phase lifecycle without disturbing it (the find is still live instantly; the observation arrives late, like BPM and the video), reuses the rails wholesale, and gives the Galaxy its first audio voice. The radio page is a near-free read surface over artifacts the pipeline already produces.

**Goals, honestly calibrated:**

- **In reach now (gated on two secrets + a library voiceId):** the full observation pipeline — firecrawl context → script → ElevenLabs render → R2 → DTO — built and validated end to end against a _stock_ voice.
- **In reach (gated on Maurice's voice-ID setup):** the same pipeline on the **bespoke Fluncle voice** (swap one secret).
- **In reach (once a handful of observations exist):** `radio.fluncle.com`, portrait, cycling.
- **Outside our control / deferred:** the bespoke voice (a human recording + consent step); landscape render (a kit capability that doesn't exist); the fully-autonomous unattended `observe` (the Hermes box).
- **Non-goal:** a 24/7 stream server, HLS/Icecast, any commercial-track-audio playback, per-listener live TTS, multi-voice dialogue, accounts/likes/chat (all explicitly out per the brief's non-goals — kept out).

**PRODUCT.md fit (stated plainly):** a recovered field-observation is _consonant_ with the canon — it's the traveler-uncle logging what he found, in the recovered-log register. The radio page must stay **dark-only, cover-led, centered, quiet, fast** (`AGENTS.md` UI rules); it is a _quiet_ continuous surface, not a flashy "now playing" dashboard. The one tension is the autoplay gate: audible audio needs a user gesture, so the page opens on a single in-voice "begin" control (the gate copy is a voice decision — §3, not "Start transmission").

---

## 2. Unit A.1 — the data model (a private `context_note`, not an overloaded `note`)

### The `note` conflict, resolved

**Verified, against the code, that `note` is taken and load-bearing:**

- `note: text("note")` is a real column (`apps/web/src/db/schema.ts:19`).
- It is in the **admin update allow-list** as an operator-curation field (`track-update.ts:31`; `docs/track-lifecycle.md:49` lists it among the writable curation fields).
- It renders as the editorial **"why"** on the public `/log/<id>` page and feeds the page's definitional prose, and a track's `MusicRecording` JSON-LD carries the editorial line — i.e. it has **public SEO/AEO value** (the log page is the archival-plate surface, `track-lifecycle.md:20-22`).
- The ROADMAP has an **"Auto-drafted finding notes"** item — a _future_ feature that auto-drafts this **editorial** note from a notes corpus + the vibe model. That is a different artifact from a firecrawl factual dump, and overloading `note` would collide head-on with it.

The brief's "store the context note in the existing unused note field" is therefore wrong twice over: `note` is neither unused nor the right _kind_ of field. The firecrawl-derived context is **internal creative fuel, never public copy** (the brief itself says this on line 46 — it just put it in the wrong column).

**Decision: a new private `context_note` column.** It holds the firecrawl-derived factual context (label, year, release context, artist background — facts only, **no lyrics quoted**, per the brief's own rule). It is **never** rendered on `/log`, never in JSON-LD, never in RSS/llms.txt, and is exposed on the public DTO only as creative-fuel parity with `features` _if at all_ (default: keep it internal, like `features_json` is training-only — see the open decision).

### The schema additions (one migration, generated)

Following the exact column style in `schema.ts` (camelCase property → snake_case column, `text(...)`, nullable, commented):

```ts
// apps/web/src/db/schema.ts — added to the tracks table

// Firecrawl-derived FACTUAL context about the track (label/year/release
// context/artist background), gathered during the observe step as CREATIVE
// FUEL for the observation script and the video agent. Internal only: never
// rendered on /log, never in JSON-LD/RSS/llms.txt, never quotes lyrics. This
// is NOT the editorial `note` (the operator's public "why").
contextNote: text("context_note"),

// The audio observation (Fluncle's recovered field observation, spoken).
// observationAudioUrl is the R2 read URL for <log-id>/observation.mp3 — set
// when the render is uploaded; its presence is the "has observation" flag.
// The script (observation.txt) and the structured artifact + render metadata
// (observation.json) live by CONVENTION at <log-id>/<name> with no column,
// exactly like poster.jpg / footage-silent.mp4 (see lib/media.ts).
observationAudioUrl: text("observation_audio_url"),
observationDurationMs: integer("observation_duration_ms"), // ms; no { mode } — plain int, like duration_ms
observationGeneratedAt: text("observation_generated_at"),
```

- **Why a column for the audio URL but not the script JSON:** `media.ts:1-9` establishes that bundle artifacts live at `<log-id>/<name>` **by convention** and only `footage.mp4` gets a DB column (`video_url`). Mirror that: `observation_audio_url` is the one column (and the "has observation" flag), while `observation.txt` (the spoken text — load-bearing: it can render under the `/log` audio control and is the re-render source) and `observation.json` (the structured `ObservationScript` + render metadata + `inputs`/`sources` provenance) are conventional R2 keys derived from the Log ID. **Trimmed from the brief (gold-plating the panel flagged): the separate `observation-render.json` sidecar is folded into `observation.json`** — render provider/model/voiceId/duration are a few fields, not a second file. Two R2 objects (`.mp3` + `.txt`) plus one JSON, not four.
- **`observationDurationMs` — how it's measured (not hand-waved):** ElevenLabs does **not** return duration (verified), and **ffmpeg/ffprobe can't run in the Worker**. So the **agent measures it** with `ffprobe` (it already has ffmpeg, per `enrichment-agent.md`) and passes `durationMs` in the `observe` request body alongside the script and the (optionally pre-normalized) mp3; the Worker persists it. Fallback if absent: the script's `durationTargetSec × 1000` with a noted ±10% budget. The radio page never re-probes.
- **Source URLs / raw firecrawl findings:** keep them **out of the DB**. The `sources[]` provenance lives in `observation.json` on R2, not a column — the brief's "store source URLs separately if the schema supports it" is satisfied by the R2 artifact, keeping the row lean.

**Generate the migration** (never hand-write SQL — `AGENTS.md`):

```bash
bun run --cwd apps/web db:generate   # drizzle-kit generate; commit the SQL + metadata with this change
```

(The migration applies automatically in the Cloudflare build via `deploy:cf` → `db:migrate`; no manual prod step.)

### The update allow-list

Extend `TrackUpdate` in `track-update.ts` with the four new fields — all **enrichment-class**, joining `bpm`/`key`/`features`/`videoUrl` as agent-writable:

```ts
// track-update.ts TrackUpdate type
contextNote?: string;
observationAudioUrl?: string;
observationDurationMs?: number;
observationGeneratedAt?: string;
```

Identity fields stay immutable (unchanged). **One real code change the panel surfaced:** `updateTrack()` today **always** appends `updated_at = ?` for any non-empty update (`track-update.ts` — there is no conditional today; the "preview-archive precedent" is a _separate_ write path, not a conditional in `updateTrack`). To honor the surfacing rule (internal writes must not move sitemap `lastmod`), `updateTrack()` gains a small visible-field check: bump `updated_at` only when the update touches a field that affects a public surface. `observationAudioUrl`/`observationDurationMs`/`observationGeneratedAt` are **visible** (the audio is playable) → bump; `contextNote` alone is **internal** → no bump. Concretely:

```ts
// track-update.ts — replace the unconditional updated_at push with:
const VISIBLE_FIELDS = [
  "bpm",
  "key",
  "note",
  "videoUrl",
  "videoVehicle",
  "vibeX",
  "vibeY",
  "observationAudioUrl",
  "observationDurationMs",
  "observationGeneratedAt",
] as const;
const touchesVisible = Object.keys(update).some((k) =>
  (VISIBLE_FIELDS as readonly string[]).includes(k),
);
if (touchesVisible) {
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());
}
```

(This also retroactively makes `features`/`contextNote`-only enrichment writes stop bumping `lastmod`, which is the correct behavior — internal training/fuel fields shouldn't move the sitemap. Covered by a `track-update.test.ts` case.)

---

## 3. Unit A.2 — the two artifacts: the context note and the observation script (the voice gate)

Maurice's framing, made concrete: **the script is not the note.** Two artifacts, two registers, two gates.

|             | `context_note` (the facts)                                                               | the observation script (the voice)                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**    | Firecrawl-derived factual context: label, year, release context, artist background. Dry. | A 20–45s recovered **field observation** in Fluncle's voice — what he saw/felt approaching the coordinate, connected to the track.              |
| **Voice**   | None — it's notes, not copy.                                                             | **Live Fluncle voice.** Must pass the voice gate.                                                                                               |
| **Source**  | The firecrawl search.                                                                    | Written _from_ the context note + track metadata + vibe placement + the video's vehicle/palette (creative fuel) — never a paraphrase of lyrics. |
| **Lives**   | `context_note` column (internal).                                                        | `observation.txt` (the spoken text) + `observation.json` (the structured artifact + `inputs` provenance) at `found.fluncle.com/<log-id>/`.      |
| **Becomes** | Creative fuel only.                                                                      | The text sent to ElevenLabs → `observation.mp3`.                                                                                                |
| **Gate**    | none                                                                                     | the **voice gate** (below).                                                                                                                     |

### The brief's script is off-canon — corrected

The brief's sample reads: _"The signal carried a clean 174 pulse… I logged it as fluncle://004.1.9E."_ and the radio gate button reads _"Start transmission."_ **Both "signal" and "transmission" are explicitly banned identity words in VOICE.md** (verified — they're on the don't-call-it list because they make Fluncle sound like a sci-fi radio operator instead of an uncle who found a tune). The script is a **live Fluncle voice surface**, so it routes through the same canon every other surface does.

- **"signal" → cut it.** The 174 is the track's pulse/pace; say it as the body felt it ("it moved at a hard, even pace"), or just state the BPM plainly as telemetry — never "the signal carried." (Verified: VOICE.md §3 bans `signal` — _"Fluncle logs findings; he doesn't pick up signals"_ — and `transmission` — _"Radio metaphor; the dimension/log metaphor replaced it."_)
- **"Start transmission" → an in-voice begin control.** The gate copy is a `copywriting-fluncle` call, not "transmission." Grounded candidates (the brand-voice panel proposed these against the register): **"Begin"** (cleanest — one word, agentless, lets the voice carry the weight), **"Let it play"** (warmer, crew-address). Recommendation: **"Begin"**. The builder must not ship "Start transmission."
- **Fix the pre-existing off-canon example as part of this work.** `track-lifecycle.md:117` uses _"Analysing the signal…"_ as a surface-string example — **off-canon by the same `signal` ban**. Since this RFC touches `track-lifecycle.md` (the observation fields join its data-model table), correct that example in the same change: _"Still listening…"_ (or _"Reading the groove…"_). Small, in-scope, and it stops the canon doc from modelling a banned pattern to future builders.

### The register — a VOICE.md §5 addition (decision, not invention)

**The brand-voice panel caught a real gap: there is no "recovered-log" or "field-observation" register in VOICE.md §5.** The §5 surface-register table today is exactly: **Web** (warm, quiet, fully in-fiction) · **Telegram** (the crew feed) · **CLI** (drier, technical, in-fiction) · **SSH** (a recovered terminal from a research vessel) · **Email** (a letter from the uncle to the crew). A spoken field observation is none of these — it's the first _heard_ surface. So this RFC does what the Hermes RFC did for Discord: **propose a new §5 row** (a canon change for Maurice to make — an open call, Decision #12), rather than silently invent a register name. Proposed row:

> **Recovered audio** | Low–Medium density | A spoken field observation in Fluncle's voice: what he saw and felt arriving at the track's coordinate. Warm, observational, deadpan-calm — the uncle saying it to a mate over the tune. Lead with the bodily reaction, then turn to the crew; no hype, no DJ patter. Heard, not read, so cadence and breath carry as much as the words.

Until that row lands, the closest existing home is the **Web** register (warm, quiet, fully in-fiction) — it's a public surface — and the script writer should ground on that. Either way the writing routes through **`copywriting-fluncle`** and holds to the named rules:

- **The Oof Test** — lead with the **bodily reaction**, not a spec readout ("a fast breakbeat at 174 BPM" is the anti-pattern). The observation opens on what it _felt_ like to arrive, not a metadata recital.
- **The Dry Rule** — no exclamation marks. Observational, sparse, deadpan-warm. No hype voice, no "what a tune / massive banger / coming up next" (the brief's own bans — they map to real canon: the no-hype/no-DJ-patter rules).
- **The Selector's three-beat / said-not-written** — it's Fluncle _saying_ this over a tune, not writing ad copy. Kin-name warmth where it fits; never "we" as a company.
- **Mention the Log ID and the artist/title** (the spine wants the coordinate + the reveal) — but speak the coordinate, don't recite a URL robotically; the `fluncle://` form is fine as the log marker.
- **Facts only from the props + the context note** — never invent a factual claim, never quote or closely paraphrase lyrics (lyrics may shape _theme_ at a high level only, per the brief's own rule `radio-brief.md:47`; and the repo's audio/source policy that keeps lyric and full-audio sources internal-only, `track-lifecycle.md:53`).

### TTS voice-direction — where it lives

The script carries delivery direction, and _how_ depends on the model (vendor thread, verified):

- **Default model `eleven_multilingual_v2`** (ElevenLabs' recommended lifelike narration model): supports a **limited SSML subset** — `<break time="0.8s"/>` for deliberate pauses — plus per-call `voice_settings` (`stability`, `similarityBoost`, `style`, `speed`). So the script is **plain prose with occasional `<break>`** and the _emotional_ direction lives in `voice_settings` (a measured, sparse read: moderate-high stability, modest style, `speed` ~0.9–0.95 so pauses breathe).
- **`eleven_v3`** (more theatrical, but a research-preview model, 5k-char cap) replaces SSML with inline **audio tags** (`[long pause]`, `[whispers]`). Richer, riskier.
- **Recommendation:** ship **`eleven_multilingual_v2` + plain prose + a couple of `<break>`s**, with the model as a **config constant** so a v3 swap is one line and the script template can branch on it. For a quiet field observation, v2 is the on-brand, stable call.

So the `observation.json` artifact is:

```ts
type ObservationScript = {
  trackId: string;
  logId: string; // the coordinate (the brief's fluncleUri == fluncle://<logId>)
  text: string; // the spoken prose (with <break/> for v2) — what goes to TTS
  durationTargetSec: number; // 20–45
  model: "eleven_multilingual_v2" | "eleven_v3"; // the config constant used
  voiceSettings: { stability: number; similarityBoost: number; style: number; speed: number };
  inputs: { usedContextNote: boolean; usedVisualSummary: boolean; usedLyricsContext: boolean };
  sources?: string[]; // firecrawl URLs (provenance), kept off the DB
};
```

### The voice gate (a hard ship requirement)

The observation script gets the Hermes-RFC voice-gate treatment, adapted for a **spoken** surface:

1. **Route generation through `copywriting-fluncle`** in the recovered-log register (the skill is the constitution; the prompt names the register + inlines the bans).
2. **Mechanical scan** (automatable, run in CI / the observe step): **zero** banned identity words (`signal`, `transmission`, and the rest of the VOICE.md list), zero exclamation marks, no "we"-as-company, no hype/DJ patter. Because it's a **spoken** surface, "sentence case" is a _display_ rule that doesn't apply to heard audio — but the bans, the Dry Rule, and the Oof Test all do, and the `observation.txt` (which may be read on the log page later) should still read in-register.
3. **The North Star sign-off (human):** _"would the uncle say this out loud over a tune?"_ — judged on the **rendered audio**, not just the text, because delivery (pace, warmth) is half the voice on a spoken surface. The first batch of observations is heard and signed off by a human before Unit B amplifies them.

This gate is why Unit A is judged on the _quality of a few observations_ before the radio page is built.

---

## 4. Unit A.3 — the `observe` endpoint + CLI (Worker-side firecrawl + ElevenLabs, R2 upload)

### The locked architecture, grounded

The agent's whole role: **poll → `fluncle admin track observe <id>` → the Worker does everything.** The CLI stays a thin HTTP client (`AGENTS.md`; `apps/cli/src/api.ts` is the Bearer client). The Worker holds every vendor secret. This mirrors video/publish exactly (`enrichment-agent.md:5`: "the Worker owns every secret… the agent holds only its admin token").

**Secrets (env.ts `envKeys`):**

- `FIRECRAWL_API_KEY` — **already declared** (`env.ts:13`), currently unused. No new secret needed for firecrawl.
- `ELEVENLABS_API_KEY` — **new** Worker secret.
- `ELEVENLABS_VOICE_ID` — **new** Worker var/secret (the chosen voice; swappable).
- R2 creds (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_ACCOUNT_ID`) — already present; reused via `r2-presign.ts`.

### The endpoint: `POST /api/admin/tracks/$trackId/observe`

A new route file `apps/web/src/routes/api/admin/tracks.$trackId.observe.ts`, structured exactly like `tracks.$trackId.video.finalize.ts` (verified template: `requireAdmin` → `getTrackByIdOrLogId` → `noLogIdResponse` guard → do work → `updateTrack` → JSON). It:

1. **`requireAdmin(request)`** (the Bearer gate; `env.ts`). Guard on `track.logId` (the Log ID is the R2 key — `noLogIdResponse()` if absent, like the video finalize).
2. **Firecrawl context fetch** — server-side `search("<artist> <title> <label> <year> drum and bass", { limit: 5 })`. **Recommendation: call the REST endpoint with plain `fetch`** (`POST https://api.firecrawl.dev/v2/search`, Bearer `FIRECRAWL_API_KEY`) rather than bundling the `firecrawl` SDK — the SDK is Node-authored and its `nodejs_compat` cleanliness on workerd is unverified for the current version; a single search payload is trivially Worker-safe over raw `fetch`. Assemble the `title`/`description` snippets into the `context_note` (facts only; **filter known lyric domains**; never store lyric fragments).
3. **Generate the observation script** from `context_note` + track metadata + vibe placement + the video's vehicle/palette (read from the bundle's `render.json`/`props.json` already in R2 as creative fuel). This is the step routed through the **voice gate** (§3). _Where the LLM call lives is an open decision (§6): in-Worker via an LLM API, or — cleaner — the script is authored by the **agent** before it calls `observe`, and passed in the request body, so the Worker stays a thin vendor-relay and the voice gate runs where the agent's skills live. Recommendation: the agent authors the script (it already holds `copywriting-fluncle`); the Worker validates it through the mechanical scan and relays it to ElevenLabs._
4. **ElevenLabs render** — `POST /v1/text-to-speech/{ELEVENLABS_VOICE_ID}` (SDK `client.textToSpeech.convert(voiceId, { text, modelId, outputFormat: "mp3_44100_128", voiceSettings })`, or raw `fetch` — same Worker-safety reasoning as firecrawl). Drain the octet-stream to a Buffer (~0.5 MB; fits 128 MB memory; a `fetch` await burns ~no Worker CPU — verified).
5. **Upload `observation.mp3` to R2** via the **same presigned-PUT pattern** the video bundle uses — but since the Worker already holds the bytes (unlike the CLI-direct video upload of ~99 MB files), and the mp3 is ~0.5 MB (well under the ~100 MB edge limit), the Worker can `R2.put()` it directly (or reuse `r2-presign.ts` for symmetry). Write `observation.txt`/`observation.json`/`observation-render.json` beside it at `<log-id>/<name>`.
6. **Finalize** — `updateTrack(trackId, { contextNote, observationAudioUrl: trackMedia(logId).observationAudioUrl, observationDurationMs, observationGeneratedAt })`. Extend `trackMedia()` in `media.ts` with `observationAudioUrl: \`${base}/observation.mp3\`` so the convention lives in one place.

### `observation-render.json` (the render metadata sidecar)

```ts
type ObservationRender = {
  trackId: string;
  logId: string;
  provider: "elevenlabs";
  model: "eleven_multilingual_v2" | "eleven_v3";
  voiceId: string;
  audioUrl: string; // found.fluncle.com/<log-id>/observation.mp3
  textUrl: string; // …/observation.txt
  durationMs: number; // probed (ElevenLabs doesn't return it)
  generatedAt: string;
};
```

### The CLI command: `fluncle admin track observe <id|logId>`

A thin command in `apps/cli` (the registry in `cli.ts` + the admin-tracks command file + the `api.ts` Bearer client), mirroring `track video` / `track update`: parse the id, POST to `/api/admin/tracks/:id/observe` with the agent-authored script in the body, print the result (the audio URL + duration). No vendor logic in the CLI — it's a relay, by design and by `AGENTS.md`.

### Audio normalization (optional polish, not a blocker)

ElevenLabs output sits ~−24 LUFS (quieter than the −16 LUFS web norm). **ffmpeg cannot run in the Worker** (no native binaries). Options: (i) **ship without normalization for v1** — output is consistent take-to-take and just plays a touch quiet; (ii) the **agent** (which has ffmpeg, per `enrichment-agent.md`) runs one `loudnorm` pass _before_ uploading, i.e. `observe` accepts an already-normalized mp3 from the agent the same way it accepts the script. **Recommendation: v1 ships without it; if loudness drifts across observations, the agent does the `loudnorm` pass** — cheapest real fix, no Worker change. Flag as polish.

---

## 5. Command-gate classification — `observe` is auto-allowed

Per the Hermes RFC §4 taxonomy (verified):

- **Auto-allowed (read + structurally-gated):** `recent`, `get`, the enrich-queue, TikTok `track draft` (inbox-only by construction), and the **analysis-scoped `track update`** (`--bpm`/`--key`/`--features`/`--status`).
- **Publish-class (human-gated):** `track add` (→ public Spotify + Telegram), `mixtapes publish*`, `track draft --platform youtube` (→ direct public upload), free-form `track update` (`note`/`videoUrl`), `submissions approve`.

**`observe` lands in auto-allowed,** for the same structural reason the analysis `track update` does:

- It writes an **internal R2 artifact** (`observation.mp3`) — audible only on a future `radio.fluncle.com` page **Fluncle controls and gates**, not pushed to any third-party public feed. It is not posted to Spotify, Telegram, YouTube, TikTok, or Discord.
- It writes a **private field** (`context_note`) and **enrichment fields** (`observation_*`) through the same curation allow-list as `bpm`/`features` — _not_ the publish surfaces.
- The one user-facing thing it produces (the spoken audio) carries **no commercial-track audio** and goes live only when the operator stands up the radio page; minting the artifact is not publishing it.

So `observe` runs **autonomously through the command gate**, like the analysis write-back — it does not need an in-chat human confirm. (The _voice_ quality gate in §3 is a separate, content-quality control, not a security gate; the first batch is human-heard, then the pipeline runs.) **Note for the wrapper builder:** the gate must scope `track update` so the **observation enrichment fields are auto-allowed** alongside `bpm`/`key`/`features`/`status` — i.e. `context_note`/`observation_*` join the safe column set, while `note`/`videoUrl` stay gated. This mirrors the Hermes RFC's "narrowly-scoped analysis-field exception."

---

## 6. Unit B — `radio.fluncle.com` (the cycling station)

A lightweight page that cycles random tracks with **both** a video and an observation, playing the observation audio over the silent footage. Built only after Unit A has minted enough observations to cycle.

### The host-rewrite (mirror `galaxy.fluncle.com` exactly)

Verified: `galaxy.fluncle.com` is served by an **isomorphic** host-rewrite in `getRouter()` (`apps/web/src/router.tsx:11-26`) — an `input` map (`galaxy.` + `/` → `/galaxy`) and a matching `output` map (so SSR and client hydration agree and the address bar stays clean). The memory canon (`tanstack-masking-replaceState-trap`, `verify-interactive-states-visually`) is exactly this: a server-only rewrite hydrates back into the wrong route. **`radio` mirrors it as a 4-line addition** to the same `rewrite` object:

```ts
// router.tsx — added to the existing rewrite.input / rewrite.output
input: ({ url }) => {
  if (url.hostname.startsWith("galaxy.") && url.pathname === "/") url.pathname = "/galaxy";
  if (url.hostname.startsWith("radio.")  && url.pathname === "/") url.pathname = "/radio";
  return url;
},
output: ({ url }) => {
  if (url.hostname.startsWith("galaxy.") && url.pathname === "/galaxy") url.pathname = "/";
  if (url.hostname.startsWith("radio.")  && url.pathname === "/radio")  url.pathname = "/";
  return url;
},
```

The route file is `apps/web/src/routes/radio.tsx`. **DNS/Cloudflare:** one Worker serves every subdomain (verified — no per-subdomain wrangler route rules; `galaxy` has none), so `radio.fluncle.com` is a **CNAME to the worker** on the same zone — an operator DNS step, no code. (The same zone already runs Media Transformations for `found.fluncle.com`.)

### `GET /api/v1/radio/random`

A new public v1 endpoint. The internal `/api/tracks/random` (`getRandomTrack()` in `tracks.ts`) is aliased into v1 today (`api/v1/tracks/random.ts` → shared `serverHandlers`), so add a **radio-eligible** variant the same way. Two grounded options:

- **Recommended:** `GET /api/v1/radio/random` — its own route, calling a `getRandomTrack({ radioEligible: true })` that filters to **`video_url is not null` AND `observation_audio_url is not null`** (both predicates ground directly in the new + existing columns; `media.ts` already proves `footage-silent.mp4` exists when `video_url` is set).
- **Or:** `GET /api/v1/tracks/random?hasObservation=true&hasVideo=true` (the brief's alt). Either is fine; the dedicated `/radio/random` reads cleaner and isolates the radio contract.

The eligibility filter is the **same `filterClauses` machinery** the enrich-queue slice extends (`listTracks`, `tracks.ts:357-380`): a `video_url is not null` clause already exists for the Stories feed (`hasVideo`); add the symmetric `observation_audio_url is not null`. So the radio filter is two `is not null` clauses on the existing query builder — no new query infrastructure.

**Response — `RadioTrack` (the silent video is the visual; the observation is the audio):**

```ts
type RadioTrack = {
  id: string;
  logId: string; // the fluncle:// coordinate
  artist: string;
  title: string;
  album?: string;
  label?: string;
  releaseDate?: string;
  bpm?: number;
  key?: string;
  vibe?: { x: number; y: number }; // the raw placement; the galaxy is derived client-side
  urls: {
    log: string; // /log/<log-id>
    spotify?: string;
    poster: string; // found.fluncle.com/<log-id>/poster.jpg (or the mode=frame transform)
    silentVideo: string; // found.fluncle.com/<log-id>/footage-silent.mp4 — NO baked audio
    observationAudio: string; // found.fluncle.com/<log-id>/observation.mp3
    observationText?: string; // …/observation.txt
  };
};
```

The DTO is built from the existing `toTrackListItem` mapper (`tracks.ts`) + `trackMedia()` (`media.ts`) — the `silentVideo`/`observationAudio` URLs come straight from the convention helper. **No commercial track audio anywhere** — the visual is the silent cut, the only audio is the observation.

### The public DTO (`TrackObservation` fields)

Expose the observation on the standard `/api/v1/tracks` DTO (the `TrackListItem` in `packages/contracts` + `toTrackListItem` in `tracks.ts`) as optional fields, **present only when set** (the surfacing rule, `track-lifecycle.md:116`):

```ts
// added to the public track DTO
observationAudioUrl?: string;
observationDurationMs?: number;
observationGeneratedAt?: string;
// observationTextUrl?: string;  // derivable from logId; expose only if a consumer needs it
```

`context_note` is **not** exposed by default (internal creative fuel, like `features_json` is training-only) — an open decision if a consumer ever wants it as video creative-fuel parity.

### The page (UI — dark, quiet, the StoriesPlayer pattern)

The radio page reuses the **existing muted-video-with-overlaid-audio playback pattern** already in the app. Verified: the Stories player (`apps/web/src/components/stories/story-view.tsx` / the stories player component) already plays `footage-silent.mp4` _muted_ with separate audio, handles preload, reduced-motion, and a one-shot `onError` fallback from the Media-Transformation rendition to the raw master (`media.ts:60-62`). The radio page is that pattern in a cycle:

- **The gate:** audible audio needs a user gesture (browsers block autoplay-with-sound). The page opens on a single in-voice **"begin" control** — **the copy is a `copywriting-fluncle` decision, NOT "Start transmission"** (banned word). After the first gesture, playback continues across cycles without re-gating.
- **The cycle loop:** fetch `/api/v1/radio/random` → load the silent video + the observation audio → display metadata (Log ID, artist — title, release/label/year, BPM, key, vibe/galaxy, a link to `/log/<id>` and to Spotify) → play the observation over the looping/letterboxed silent video → on the observation's `ended`, fetch the next random track → repeat forever. **Preload the next** track's assets during the current segment for a smooth transition (mirror the Stories preload).
- **Broken-asset skip:** if either the silent video or the observation mp3 fails to load (a stale or missing R2 object), **skip to the next** random track rather than stall (the `onError` one-shot already exists for the video; add the symmetric handling for the audio). The endpoint already only _returns_ eligible tracks, but the client still guards against a 404 on the object.
- **Portrait now, landscape later:** the kit emits **1080×1920 only** (`packages/video/README.md` — "1080×1920 vertical clips"), so the radio page **letterboxes the portrait silent footage** centered on the dark field for MVP. Landscape (`footage-silent-landscape.mp4`) is a _kit_ capability that doesn't exist; honestly scoped out (§ Decisions), and the page is built to swap to a landscape source when one exists.
- **Constraints (`AGENTS.md` UI rules):** dark-only, cover-led, centered, quiet, fast; Shadcn from `components/ui/`, no headless primitives; WCAG AA on the metadata + controls; respect reduced-motion (the silent video's motion is the only motion — gate it behind `prefers-reduced-motion` to a static poster if set, with the observation still audible).

---

## Sequencing & ownership

1. **Shared prerequisite — the enrich-queue status slice** (`ListTracksOptions.status` + `filterClauses` clause + GET param + CLI `enrich-queue`, with unit tests). This is the **Hermes RFC's** slice; whichever of the two RFCs ships first builds it. The observation queue (`enriched + context_note + video + no observation yet`) is this machinery plus two predicates — do **not** reinvent it.
2. **Unit A.1 — schema** (the `context_note` + `observation_*` columns, the generated migration, the `TrackUpdate` allow-list extension). Smallest, lands first; everything else depends on it.
3. **Unit A.2/A.3 — the pipeline** (the `observe` endpoint + CLI, firecrawl context, the script + **voice gate**, ElevenLabs render, R2 upload, DTO fields, `media.ts` convention). Built and validated against a **stock library voiceId** — no human blocker. The first batch of observations is **heard and North-Star-signed-off** before Unit B.
4. **Bespoke voice** — Maurice produces `ELEVENLABS_VOICE_ID`; swap the secret; re-render. Gates the _final voice_, not the build.
5. **Unit B — `radio.fluncle.com`** (host-rewrite, `/api/v1/radio/random`, the `/radio` page + cycle loop, the in-voice gate copy, the CNAME). Built once a handful of observations exist.

- **Parallelizable:** the enrich-queue slice, the schema migration, and the radio host-rewrite are independent edits. The pipeline gates the page (the page needs artifacts); the schema gates the pipeline.
- **The one thing that de-risks the most:** building Unit A against a **stock voiceId** and **hearing the first three observations** before any further investment — that's the cheap falsification of the whole brand bet (does a synthetic Fluncle voice clear the North Star?), exactly as Hermes' Unit 0 falsifies its bet for free.

---

## Decisions needed BEFORE handoff

1. **The `note`-field call (recommended, confirm):** a **new private `context_note` column**, _not_ an overload of the editorial `note`. (`note` is the public "why" with SEO/AEO value + a roadmap auto-draft feature — verified.)
2. **The context-vs-editorial split (confirm):** `context_note` is internal creative fuel (never on `/log`, never in JSON-LD/RSS); the observation **script** is the voice surface. Confirm `context_note` stays off the public DTO by default.
3. **ElevenLabs voice setup (the one human blocker — ask for Maurice):** choose **(a) a library voice** (instant, generic), **(b) Instant Voice Cloning** (1–2 min clean recording + consent, ~Creator tier — recommended for a signature narrator), or **(c) Professional Voice Cloning** (30+ min + voice-captcha, overkill now). Do the recording + consent step if cloning, and hand over `ELEVENLABS_VOICE_ID`. The pipeline builds against a stock voice meanwhile.
4. **Paid vendors + secrets (ask for Maurice):** ElevenLabs **Creator (~$22/mo)** (commercial rights + IVC) and Firecrawl **Hobby (~$16/mo)** are the recommended floors for an ongoing public surface (confirm exact dollar figures in-dashboard). New Worker secrets: **`ELEVENLABS_API_KEY`**, **`ELEVENLABS_VOICE_ID`** (`FIRECRAWL_API_KEY` already exists).
5. **The model + script format (recommended, confirm):** **`eleven_multilingual_v2`** + **plain prose with occasional `<break/>`** + `voice_settings` for the sparse read (stable, on-brand) — as a **config constant** so a v3-audio-tags swap is one line.
6. **The in-voice gate copy (a `copywriting-fluncle` call):** the radio "begin" control is **not "Start transmission"** (banned word). Decide the recovered-log "begin" copy. Likewise the "still observing"/loading copy.
7. **Where the script LLM call lives (recommended):** the **agent authors the script** (it holds `copywriting-fluncle`) and passes it to `observe`; the Worker mechanically scans + relays it to ElevenLabs (keeps the Worker a thin vendor-relay, runs the voice gate where the skills live). Confirm vs an in-Worker LLM call.
8. **The radio subdomain + Cloudflare host-rewrite (ask for Maurice):** approve the `radio.fluncle.com` CNAME-to-worker DNS step (the code rewrite mirrors `galaxy`; the DNS is operator-only).
9. **Normalization (recommended, confirm):** ship v1 **without** loudness-normalization; if observations drift in loudness, the **agent** does a `loudnorm` pass before upload (ffmpeg can't run in the Worker).
10. **Landscape render (honest scoping, confirm parked):** out of scope until the `packages/video` kit emits a landscape cut; portrait letterboxes meanwhile.
11. **Enrich-queue status-slice ownership (confirm before building):** the `ListTracksOptions.status` + `filterClauses` slice is co-owned with the Hermes RFC (see Risks #7). Confirm which RFC owns and ships it so it is built **once** — if Hermes lands it first, this RFC consumes it; if not, this RFC ships it. Do not let both invent it.
12. **A new VOICE.md §5 register row for recovered/heard audio (a canon call for Maurice — OPEN):** the §5 surface-register table has no register for a _spoken_ field observation — the first _heard_ surface. This RFC **proposes** a new "Recovered audio" row (drafted in §3), as the Hermes RFC proposed a Discord row, but adding a §5 register is a canon change only Maurice makes. Decide whether to add the row (and its exact wording) or to ground the script on the existing **Web** register until then. Open, not decided.

---

## Acceptance criteria

**Shared slice — ship gate (if not already landed by Hermes):**

- `ListTracksOptions.status` + the `filterClauses` status clause + GET param + `fluncle admin enrich-queue`, with **unit tests in `apps/cli` + `apps/web`**, covering `pending ∪ failed ∪ stale processing`. (Owned jointly with the Hermes RFC — build once.)

**Unit A (observation pipeline) — ship gates:**

- The migration (`context_note`, `observation_audio_url`, `observation_duration_ms`, `observation_generated_at`) is **generated** via `db:generate` (not hand-written), committed with its metadata, and applies cleanly. `TrackUpdate` gains the four fields; identity fields stay immutable; `context_note`-only writes do **not** bump `updated_at`, the observation-audio write does.
- `POST /api/admin/tracks/:id/observe` exists, `requireAdmin`-gated, mirrors the video-finalize structure, guards on `logId`. It fetches firecrawl context → relays the (agent-authored) script to ElevenLabs → uploads `observation.{mp3,txt,json}` + `observation-render.json` to `<log-id>/<name>` on R2 → writes `context_note` + `observation_*` back. `media.ts` gains the `observationAudioUrl` convention. **Unit tests** mirror `r2-presign.test.ts` / the video route tests (a fake vendor + R2 boundary).
- `fluncle admin track observe <id|logId>` is a thin CLI relay (no vendor logic), wired in `cli.ts` + the admin-tracks command + `api.ts`.
- **The voice gate passes:** the observation script routes through `copywriting-fluncle` (recovered-log register); the **mechanical scan** finds **zero** banned identity words (`signal`/`transmission`/the rest), zero `!`, no "we"-as-company, no hype/DJ patter; and a human **North Star sign-off on the rendered audio** ("would the uncle say this out loud over a tune?") is recorded for the first batch. The brief's `signal`/`transmission` examples are corrected.
- Token-only invariant verified: the agent box holds only `FLUNCLE_API_TOKEN`; `ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID`/`FIRECRAWL_API_KEY`/R2 are Worker-side (`env.ts`). `observe` runs **autonomously** through the command gate (auto-allowed); the gate's `track update` scope includes the observation enrichment fields, while `note`/`videoUrl` stay gated.
- The public `/api/v1/tracks` DTO exposes `observationAudioUrl`/`observationDurationMs`/`observationGeneratedAt` **only when set**; `context_note` stays internal.
- A `docs/agents/observation-agent.md` operating doc lands (the observe step in the enrich chain, the script + voice-gate contract, the R2 paths, the safety rails — no lyrics, facts only, the audio is not commercial track audio), linked from `enrichment-agent.md` + `track-lifecycle.md`.

**Unit B (`radio.fluncle.com`) — ship gates:**

- The `router.tsx` rewrite gains the `radio.` ↔ `/radio` isomorphic pair; `radio.fluncle.com/` serves `/radio` with the address bar unchanged and **no hydration mismatch** (verified in a driven real browser **past hydration**, per the `verify-interactive-states-visually` canon — not just curl). The CNAME is documented as an operator step.
- `GET /api/v1/radio/random` returns only tracks with **both** `video_url` and `observation_audio_url` set, as a `RadioTrack` whose video is the **silent** cut and whose only audio is the observation; **unit test** for the eligibility filter (an ineligible track never returns).
- The page cycles: fetch → silent video + observation audio → metadata + links → on `ended`, next; **preloads the next** segment; **skips broken assets** (a 404 on either object advances rather than stalls); opens on the in-voice begin gate (not "transmission"); plays **no commercial track audio**. Portrait letterboxed; reduced-motion respected; dark/quiet/AA; Shadcn-only.

**Not a ship gate (honest scoping):** the bespoke voice (swap-a-secret later); landscape render; the fully-autonomous unattended `observe` (the Hermes box). Built to accept each when it lands; not blockers.

---

## Risks & open questions

1. **The spoken-surface voice risk (top risk).** A synthetic voice _says_ a banned word or reads flat, and it can't be skimmed past — the cost of off-voice is higher heard than read. Mitigated by the voice gate + the **North Star sign-off on rendered audio** for the first batch, _before_ Unit B amplifies it. The whole bet is falsified cheaply by hearing three observations against a stock voice.
2. **The brief's data-model error, if uncaught, corrupts `note`.** Overloading `note` with firecrawl dumps would overwrite operator editorial copy that renders publicly and collide with the roadmap auto-draft feature. The `context_note` column is the fix; the builder must not write firecrawl output to `note`.
3. **Worker/vendor compatibility.** The `firecrawl`/`@elevenlabs/elevenlabs-js` SDKs are Node-authored; `nodejs_compat` cleanliness on workerd is unverified for current versions. **Mitigation: raw `fetch` to the REST endpoints** (both are simple HTTP) sidesteps the SDK bundle entirely — recommended. Verify the chosen path in `wrangler dev`.
4. **ffmpeg-in-Worker is impossible.** Loudness-normalization can't run in the Worker. v1 ships without it (output is consistent, just quiet); the agent does the `loudnorm` pass if drift appears. Not a blocker, but don't promise normalized audio from the Worker.
5. **Lyrics leakage.** Firecrawl returns lyric-site snippets. The `context_note` must store **facts only**; the script must never quote/closely-paraphrase lyrics (canon + the brief's rule). Enforce in the generation prompt + filter known lyric domains. A leaked lyric in a _spoken_ artifact is a copyright + voice problem at once.
6. **Eligibility vs. reality drift.** `/api/v1/radio/random` returns tracks the DB _thinks_ are eligible, but an R2 object can be missing/stale (the `r2-purge-needs-media-transforms` canon shows transform renditions cache separately). The client **must** skip on a load error, not trust the endpoint blindly.
7. **Shared-slice coordination.** The enrich-queue status slice is co-owned with the Hermes RFC. If both build it, they conflict; if neither does, both break. Sequence it as a shared prerequisite, built once.
8. **Scope honesty.** The pipeline is real and in reach; the _bespoke voice_ and _landscape_ are honestly parked behind real external blockers, not cut; the "separate audio agent" is not a new runtime (it's one more step the enrich agent / Hermes box runs). Resist bundling landscape or a 24/7 stream into v1 — the brief's non-goals are kept out.

---

## Appendix — verifications & sources

**Live verifications (against the worktree code):**

- **`note` is taken + public:** `apps/web/src/db/schema.ts:19` (`note: text("note")`); in the update allow-list `track-update.ts:31`; `docs/track-lifecycle.md:49` lists it among writable curation fields; the `/log` page is the archival-plate surface with `MusicRecording` JSON-LD (`track-lifecycle.md:20-22`); ROADMAP has an "Auto-drafted finding notes" item. → a separate `context_note` is required.
- **The enrichment status machine:** `enrichment_status text … default("pending")` (`schema.ts:13`); the update allow-list types it `"pending" | "processing" | "done" | "failed"` (`track-update.ts:19`). No status filter exists in `ListTracksOptions` (`tracks.ts:316-335`) or the `listTracks` `filterClauses` builder (`tracks.ts:357-394`) — confirms the Hermes RFC's claim; the queue slice is shared.
- **The R2 convention + presign:** `apps/web/src/lib/media.ts:1-42` is the single source of `found.fluncle.com/<log-id>/<name>` (only `footage.mp4` gets a column; poster/silent/cover/note are by convention) — the model for `observation.mp3`. The presigned-PUT flow is `tracks.$trackId.video.uploads.ts` → CLI PUT → `tracks.$trackId.video.finalize.ts` (verified template, `requireAdmin` → `getTrackByIdOrLogId` → `updateTrack`). R2 creds + `FIRECRAWL_API_KEY` are already Worker secrets (`env.ts:13,22-25`); the agent holds only `FLUNCLE_API_TOKEN` (`enrichment-agent.md:5`, `track-lifecycle.md:28`).
- **The host-rewrite:** `apps/web/src/router.tsx:11-26` — the isomorphic `galaxy.` ↔ `/galaxy` `input`/`output` rewrite in `getRouter()`; `radio` mirrors it (4 lines). One Worker serves all subdomains (no per-subdomain wrangler routes). The random v1 alias is `api/v1/tracks/random.ts` → shared `serverHandlers` from `api/tracks/random.ts` (`getRandomTrack()` in `tracks.ts`).
- **The video creative-fuel handoff (the "note feeds video" idea, grounded):** `packages/video/README.md` — `track.features` is already passed to `NostalgicCosmosProps` as optional CREATIVE FUEL that steers vehicle/texture/palette; `context_note` extends that same handoff. The bundle paths (`footage.mp4`, `footage-silent.mp4`, `poster.jpg`, `note.txt`, `composition.tsx`/`props.json`/`render.json`) are the convention `observation.*` joins.
- **Voice:** `VOICE.md` / `packages/skills/copywriting-fluncle/references/voice.md` — `signal` and `transmission` are banned identity words; the Dry Rule (no `!`), the Oof Test (lead with the bodily reaction), the Selector's three-beat / said-not-written, no-hype/no-DJ-patter, no "we"-as-company. The brief's `signal` (line 136) and `transmission` (line 300) are off-canon; `track-lifecycle.md:117`'s "Analysing the signal…" is a pre-existing off-canon example (flagged, out of scope).

**Vendor verifications (npm registry + docs, dated 2026-06-20):**

- **ElevenLabs SDK:** `@elevenlabs/elevenlabs-js@2.53.1` (the bare `elevenlabs` package is **deprecated → moved**). `POST /v1/text-to-speech/{voice_id}`; `client.textToSpeech.convert(voiceId, { text, modelId, outputFormat })` → octet-stream bytes. **No duration in the response** (probe it). Recommended narration model **`eleven_multilingual_v2`** ("most lifelike… for voiceovers/content creation"); `eleven_v3` is a more-expressive research-preview (audio tags, 5k cap). Default format `mp3_44100_128` (~0.5 MB / 30s). `voice_settings`: `stability`/`similarityBoost`/`style`/`speed`/`useSpeakerBoost`. v2 SSML subset = `<break>` only; v3 = inline audio tags. ~−24 LUFS output (normalize to −16 with ffmpeg out-of-Worker). Tiers: Starter (commercial), Creator ~$22 (IVC), Pro ~$99 (PVC). Voice setup: library (instant) / IVC (1–2 min + consent) / PVC (30+ min + voice-captcha). Sources: ElevenLabs docs (models, convert API ref, voice-cloning, SSML/pauses, v3 audio tags), npm registry.
- **Firecrawl SDK:** `firecrawl@4.28.2` (== `@mendable/firecrawl-js@4.28.2`, same SDK; `firecrawl` is the canonical newer name). `firecrawl.search(query, { limit })` → `{ web: [{ title, url, description }], … }`. Search = 2 credits / 10 results (~1–2 credits per observe at limit 5); Hobby ~$16/mo for ongoing use. **Worker note:** Node-authored SDK; `nodejs_compat` unverified → prefer raw `fetch` to `POST https://api.firecrawl.dev/v2/search`. Lyrics rule: factual context only. Sources: Firecrawl docs (search), npm registry, 2026 pricing roundups.
- **Cloudflare Worker constraints:** a `fetch` _await_ does **not** count toward CPU time (the render runs on ElevenLabs' servers); 128 MB memory holds the ~0.5 MB mp3; subrequest cap (10k) is untroubled by a handful of calls; CPU raisable to 5 min via `cpu_ms`. So the Worker can run firecrawl + ElevenLabs + R2 in one request without streaming-to-R2. ffmpeg cannot run in-Worker. Sources: Cloudflare Workers limits/performance/CPU docs (2026).

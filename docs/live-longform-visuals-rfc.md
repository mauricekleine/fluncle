# RFC: Fluncle Live + Longform — the journey through the glass, and the set as one artwork

**Status:** Final (research → taste pass → 3-role adversarial panel synthesized, 2026-07-03) — completeness standard applied.
**For:** a fresh build session / a team of agents, after the six decisions below are resolved.
**Canon/authority:** DESIGN.md, VOICE.md, PRODUCT.md, the fluncle-video skill (the doctrine), `packages/video` (code-of-record), `docs/mixtape-recording-setup.md` (the recording chain this must preserve). This document is planning, not spec.

> Process note: five research threads (reliability + live flash safety; platform/perf/topology/UX with real measurements on the operator's hardware; the Rekordbox live data plane; the offline hour-long pipeline; the scenes contract), grounded in a working live spike (2026-07-03: BlackHole → Web Audio DSP → the production GLSL vocabulary at a locked 60 fps against real Rekordbox master audio). Then a taste pass and a three-role adversarial panel (staff engineer — verified claims against real code and fetched compositions; live show-ops; brand canon/product). Their corrections are baked in throughout; the largest ones reshaped the architecture and are marked **[panel]**. Verifications in the appendix.

## The standard (definition of done)

Every unit ships complete — implementation, tests, documentation, the operator runbook — before the run is done. Sequencing below orders a complete delivery; it is not a menu. The only sanctioned external gates, each named where it occurs: the three **day-one de-risks** (§Sequencing), and the operator's taste calls, made on rendered evidence, never in the abstract.

## 0. Summary / the reframe

- **The fiction comes before the craft** **[panel: canon]**. The archive's videos are log entries _sent back_; the live surface is **the journey as it happens — the view through the ship's glass**. The finding-morph is _arrival at a logged coordinate_ (the archive asserting itself live, the Log ID surfacing in the fixed grammar); unknown tracks are _uncharted space_, not fallback content. The hour-long set video is the mixtape's canon object made visible: **Fluncle dreaming — the set travelling through the findings' own worlds**, transitions as travel between them. Every design decision below derives from this; a build that satisfies only the material rails (palette, grain, flash) and not the fiction has failed the doctrine's first law ("a log entry, not a visualizer"). The word "visualizer" does not name this product; working name **Fluncle Live / the glass**, copy through VOICE at build.
- **The architecture, honest form** **[panel: staff-eng — corrected from the draft]**: the offline pipeline is the author and certifier; the live runtime **replays, never authors**. But archived finding bodies are NOT mechanically replayable — real compositions drive their arcs through JS-computed custom uniforms and `bloom`/`reactivity` props outside the shader (verified: 5/6 shipped comps). So the live scene model is two-tier: **(v1) identity morphs** — every finding is already live-morphable _today_ via its public `props.json` (palette + seed) applied to a certified default vehicle, with the Log ID surfacing on arrival; **(v2) full-body replay** — scenes authored under the new `fluncle.scene/1` contract (a going-forward authoring rule: live-ready bodies read header uniforms only) replay their entire world live. No backfill problem exists: v1 needs nothing the archive doesn't already publish.
- **Performance is settled by measurement:** ~1.25 ms/frame at 1080p on the M5 (~7% of a 60 fps budget; crossfade +5%; DSP 0.016 ms), ≤~18% derated to the M2. Encoding rides the Media Engine ASIC (VideoToolbox). The engineering problem is reliability and safety, not GPU cost.
- **The show ships v1 without rkbx_link** **[panel: show-ops counter-position, adopted]**: a root memory-scraper on a re-signed Rekordbox does not belong on the mission-critical mixing machine to gain identity that the operator (at the decks, knowing what's loading) can cue with a keystroke and that the mixtapes skill reconciles offline anyway. v1 = audio-energy DSP + audio drop-detection + manual finding-cue keys. rkbx_link is the v2 luxury, gated on its own hardware verification.
- **Topology: a mixing machine and a streaming/recording machine.** M2 Pro: Rekordbox + FLX4 + Rekordbox REC, nothing else. M5 Pro: the glass, the bridge, OBS (VideoToolbox), mic, camera. Audio crosses on an **analog splitter as primary** (network-proof; latency and bit-perfection are explicitly irrelevant to this feed) **[panel: show-ops — flipped from SonoBus-primary]**; SonoBus-over-wire is the convenience option. One-Mac remains fully budgeted as the fallback; config, not code, decides.
- **Truly coupled:** the scene contract, the uniform header, the default family + the canon holding scene. **Independent:** the live show and the hour render share the spine but ship independently; the bridge is useful alone; the flash limiter is portable.

## 1. Context & goals

The per-track pipeline (overhauled 2026-07-02) ships gated, music-honest shader compositions. Two operator ambitions follow: an hour-long generated artwork per mixtape/set, and live on-the-fly visuals behind the decks. The spike proved the live loop end-to-end on the real rig. This RFC turns both into one buildable architecture.

In reach: everything below, on existing vocabulary and measured budgets. Outside our control, stated honestly: rkbx_link's offsets across Rekordbox updates (v2, pinned + rehearsed); macOS/Chrome permission and update drift (pinned runtime + checklist, §5); taste outcomes (settled on rendered evidence, decisions 2/6).

## 2. Unit S — the scene contract (`fluncle.scene/1`)

**The manifest is small; the taste pass halved it and the panel re-shaped it** **[taste + staff-eng]**. What ships:

```jsonc
{
  "schema": "fluncle.scene/1",
  "id": "032.0.4L", // logId for findings; member id for defaults
  "kind": "finding", // "finding" | "default" | "holding"
  "glsl": {
    "body": "…", // fully RESOLVED fragment body (GLSL.* deps inlined by the emitter)
    "headerVersion": "cosmos.header/1", // pins the CORE_UNIFORMS contract
    "glsl3": false,
  },
  "palette": ["#0b0a10", "#8e0a2e", "#cc5374", "#f4ead7"],
  "grain": { "family": "grainChemicalDye", "amount": 0.05 },
  "bloom": { "threshold": 0.72, "intensity": 0.6, "radius": 0.9 }, // optional; the multipass config is load-bearing
  "reactivity": { "drop": { "riseMs": 900, "holdMs": 400, "fallMs": 2200 }, "swellBeatWeight": 0 }, // envelope shape; peakTimeMs deliberately absent (live detects; offline injects per render)
  "cleared": {
    "beatPull": "pass",
    "flash": "pass",
    "arc": "pass",
    "metricsVersion": "…",
    "at": "…",
  },
}
```

Rulings baked in from the panel:

- **Cut from the draft schema** **[taste]**: the descriptive `bindings[]`, `register`, `motionModel`, `climax`, `morph`, `requiredUniforms` — no host reads them; `intent.json` (which ships beside it) already carries the descriptive record for the judge. The one real load-time check kept: `palette[0]` under the warm-dark ceiling. The "Motion-law as a manifest type-check" is deleted as enforcement theater — the real enforcement is the measured ship-time gate, carried in `cleared`.
- **`cleared`, not `certified`** **[canon]**: "certifies" is Fluncle's protected verb (he certifies bangers); the QA stamp must not collide with it.
- **The live-ready authoring rule (the contract's teeth)** **[staff-eng D1/D5]**: a scene body whose manifest is emitted MUST read **header uniforms only** — no custom uniforms driven by clip-time JS. This is not a new constraint invented here; it is the video doctrine's existing scripted-clock law ("drive the structural arc from the live envelopes") finally made mechanical. The emitter statically scans the body: custom `uniform` declarations beyond the header ⇒ the scene is marked not-live-ready (it still ships everything else). The fluncle-video skill gains this as the ship requirement going forward; the journey baseline that comps legitimately used `interpolate(sec,…)` for maps to `u_progress` (offline: clip progress; live: track playhead or dwell — the same uniform, both hosts).
- **Emission is module evaluation, not text extraction** **[staff-eng D2]**: `frag` consts interpolate `${GLSL.*}` (verified: all interpolations across shipped comps are bare `GLSL.*` refs), so `ship` resolves the body by importing the composition module and the `GLSL` object — and refuses (with a clear error) any interpolation that is not a bare `GLSL` member.
- **Textures** **[staff-eng D6]**: a body that samples textures declares them (`glsl.textures: [{ name, source: "artwork" }]`); the offline host passes `track.artworkUrl`, the live host fetches the matched finding's artwork (CORS-clear). Scenes with non-artwork textures are not-live-ready.
- **The upload change is three files, not one** **[staff-eng D4]**: `video-bundle.ts` (`VIDEO_ARTIFACTS` entry) + `apps/cli/src/commands/track.ts` (option + field map) + `apps/cli/src/cli.ts` (flag + `--dir` wiring) — precedent #254.
- **Hosts:** offline `SceneHost` (thin over `ShaderLayer`, now also passing `bloom`/`reactivity`); live `LiveSceneHost` (the spike generalized, importing `shader-header.ts` for byte-identical injection, DSP mapped to the canonical names — `u_audioSwell`, not the spike's `u_swell`). **Proof obligations, corrected** **[staff-eng S4]**: (a) offline round-trip — a _new-contract_ scene rendered from its manifest matches its composition render; (b) **live replay** — one real new-contract finding body runs in the live host and is eyeballed correct. The round-trip alone proves nothing about live.

**The default family + the holding scene:** the spike's three vehicles promoted to `scene.json`, hand-run once through the gates — plus a **fourth: the canon holding scene** **[canon]** — Warm Dark ground, grain boiling at the floor, beat-clock-only ambient motion, no gold. It is the single terminal state of the failure matrix, the flash-limiter trip target, AND the blackout key. Uncharted-space palettes come from a small **hand-cleared canon palette set** (warm-dark grounds, canon-vetted accents, cool held to counter-accent weight) selected by `hash(normalizedTitle)` — never continuous hue rotation **[canon: Retint]**; the set is built on the four vibe-map galaxies' territory (decision 4).

**Uniform parity** (all names verified against `CORE_UNIFORMS`): identical — `u_time u_res u_palette` + all bands/fast/fine/flux; reinterpreted — `u_beatPulse u_downbeatPulse` (v2: OSC phase; v1: DSP), `u_onsetPulse u_audioHit u_audioSwell u_audioDisturbance` (DSP composites), `u_seed` (`hash(title)` / finding seed); divergent — `u_progress` (playhead/dwell), `u_audioDrop` (**detected** live: DSP dip→surge, ∪ phrase look-ahead in v2 — the scripted-clock law already ruled this; it is not a decision **[canon]**).

## 3. Unit L — the glass (the live runtime)

`packages/live`. A plain, **pinned** Chromium (`--app`, auto-update disabled, own profile — "verify the version" is a diagnosis, not a remedy **[show-ops]**) fullscreen on the show display. Not an OBS Browser Source (its CEF cannot `getUserMedia` BlackHole; documented fallback only). Not Electron/Tauri/Metal (declined on measurement).

**Render loop:** WebGL1, single draw, vsync-locked, capped to the stream fps; render scale 0.75 default with the `r`-cycle degrade lever; the spike's fixed perf traps kept as law. WebGPU: not now.

**Audio capture, mandated constraints** **[show-ops — the invisible-corruption catch]**: `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })` and the AudioContext forced to 48 kHz — Chrome's defaults (AGC, noise suppression) would pump the energy envelope and gate the transients while OBS's copy sounds fine. Non-negotiable; in the pre-show checks.

**The scene flow (v1):** uncharted space (default vehicle + hash-selected canon palette) → operator cues or the auto-morph detects a transition → on a finding match (v1: manual cue; v2: bridge identity), **arrival**: the world morphs toward the finding — its palette and seed from its public `props.json` (already on R2, CORS-clear — no backfill artifact needed), its full body when the scene is live-ready — and the **Log ID surfaces in the fixed grammar** (Oxanium tabular, telemetry conventions, scene-derived ink, never brand gold), timed to the arrival, clearing so the drop plays on pure art. This is canon law, not an option **[canon: the Log ID names the finding on every surface]**.

**The constructive rails — one shared post-pass FBO** (rails + flash monitor + diagnostics in one chain; scene bodies write `gl_FragColor`, so rails are a post-pass, not an append):

1. Warm Dark: `min(tonemap(col), warmDarkCeiling)`; manifest palette check at load.
2. Grain floor: host-applied `filmGrain` at `max(scene.amount, floor)`.
3. **The flash limiter** (first-principles; no VJ-industry prior art exists — labeled as such): a global luminance scalar with a 1-second ring buffer running the exact WCAG 2.3.1 math (opposing pairs ≥10% relative-luminance delta, darker endpoint <0.80; the area exemption is unusable fullscreen); a 4th flash in any trailing second is eased, never emitted; ≥66 ms minimum transitions; an independent saturated-red limiter (R/(R+G+B) ≥ 0.8, Xbox XAG-118 proxy, calibrated). Design law: 174 BPM kicks land at 2.9 Hz — _at_ the boundary; kick energy binds only through the limited scalar. Output-side second net: async-readback luminance from the shared FBO, the same counter in JS, easing to the **holding scene** on trip, every trip logged. Validated offline via PEAT on a recorded session — including the **composited OBS output** (camera cuts create flashes the bare pass misses) **[show-ops]**. Never marketed "epilepsy-safe."
4. **Manual controls route through the same easing** **[show-ops + canon]**: blackout is a guarded key (hold-to-engage) easing ≥66 ms into the holding scene — a held breath, not an off switch, never `#000000`; intensity modulates the scene's material response under the white-out cap, never a raw framebuffer gain.

**Reliability rails:** `preventDefault()` in `webglcontextlost` (mandatory), full resource-graph rebuild shared with cold boot, `WEBGL_lose_context` on a debug key as the pre-show smoke; two-tier watchdog (in-page heartbeat + the bridge as out-of-process supervisor relaunching Chromium); explicit `gl.delete*` on scene retirement + rehearsal heap snapshots; audio-device loss handling (`track.onended` + `devicechange` + gesture-free re-acquisition + context rebuild on rate mismatch) terminating in the holding scene; page-lifecycle flags + `caffeinate` primary + wake-lock secondary + App Nap off + lid open; **an OBS fallback scene** (a static brand card, one-key cut, independent of the browser) covering watchdog-relaunch seconds **[show-ops]**.

**Control surface, one tier for v1** **[taste]**: keyboard — scene keys, finding-cue, guarded blackout, intensity, render scale, HUD. The phone web-remote (served by the bridge) is the one earned second tier for the two-machine rig; added after dress rehearsal shows the need, not before. The MIDI tier and preview/program canvas are cut from v1. **The control surface is a canon surface** **[canon]**: DESIGN tokens, dark-only, Oxanium/mono per One Voice, canon status colors (no traffic-light green), every string through VOICE — the `/admin/tag` precedent, not a SaaS dashboard.

## 4. Unit B — the bridge and the data plane

One Bun process in `packages/live`, stateless-restartable, one WebSocket `ShowState` stream (30–60 Hz, per-channel staleness, `seq`/`t`), doubling as the watchdog supervisor and the show-start orchestrator.

- **v1 channels:** renderer-local audio (the DSP is in the page; the bridge carries state, health, the phone remote, and the supervisor role) + the matcher index (preloaded from the public API — the `TrackListItem` DTO already carries logId/bpm/key/vibe/galaxy/vehicle/grain/register; paged at show start; no new API surface needed for v1).
- **v2 channel — rkbx_link**, gated on its own hardware verification: OSC per deck (bpm, beat/bar phase via `subdiv/1|4`, track title/artist, **phrase look-ahead** with count-in — pre-arming arrivals), `osc.destination` pointed at the M5 (config, not code). Deployment reality stated plainly: re-signed Rekordbox + sudo + offsets pinned to 7.2.8 — which is exactly why it is v2 **[show-ops]**. The matcher (the `key_backfill` identity tuple ported to TS: folded artist set, base title, version-descriptor-as-identity; ≥0.9 adopts, else uncharted) and prefetch-on-the-non-live-deck ship with v2. Ableton Link: dropped (JS bindings are abandonware; OSC carries tempo+phase); a LinkKit sidecar only if a second net ever proves needed.
- **Audible-deck inference (v2):** audio-energy dominance primary; the FLX4 crossfader CC added only if rehearsal shows misses.
- **The DSP worklet** ports the pipeline's streaming-shaped kernels (band conventions, superflux onsets, transient emphasis, EMA/swell; rolling-peak normalizer) and does not port BPM/beat-grid/downbeats/drop-scan. The Worklet owns texture and energy; musical time comes from DSP (v1) then rkbx_link (v2).
- **Failure matrix invariant, honest form** **[show-ops]**: every degradation path terminates at renderer-local DSP + last-known clock + the holding scene — and in the two-machine config the audio _signal_ is only truly local on the analog splitter (SonoBus makes the device local but the signal remote). The single-cable fault (audio + OSC together in v2) is a modeled, rehearsed case, not two independent rows.
- **AV-sync calibration recipe** (runbook): four-on-floor loop, DSP kick flash vs beat flash, dial the offsets; the transport's buffer latency feeds `audioLatencyMs`.
- **Day-one de-risk:** `osc-js`/Bun `node:dgram` verification is promoted to the de-risk tier **[staff-eng S3]** (it is v2's primary channel, but cheap to settle now).

## 5. Unit T — topology and the show

**Primary: the two-machine split.** M2 Pro (_mixing machine_): Rekordbox + FLX4 + Rekordbox REC — genuinely nothing else in v1. M5 Pro (_streaming/recording machine_): the glass + bridge + OBS + **the mic (Scarlett/Q2U relocates to the M5** — Track 2 is impossible otherwise; the draft forgot this **[show-ops]**) + camera(s). The NDI-back-to-M2 variant stays rejected.

- **Audio transport: analog splitter PRIMARY** **[show-ops]** — FLX4 master RCA split → class-compliant USB interface on the M5. Rationale: the master of record is Rekordbox REC on the M2 regardless; this feed serves the glass + the stream, needs neither low latency nor bit-perfection, and the splitter is network-proof (survives the single-cable fault). SonoBus-over-wire (explicitly configured: uncompressed PCM 48 kHz, jitter buffer sized for reliability; never Wi-Fi on show night) is the convenience alternative — the "bit-clean" claim applies only when so configured. Multi-client BlackHole on the M5 (transport in; OBS + Chrome reading) is verified-supported but rehearsal-checked at three clients.
- **Masters of record, stated:** the OBS `.mov` (3-track model, unchanged: music→1+3, mic→2+3) lives on the **M5**; the deliverable extraction (`fluncle-mixtapes`) runs there; Rekordbox REC WAV on the M2 is the belt-and-braces master. Disk headroom on both is a checklist line.
- **Capture:** OBS Display Capture (ScreenCaptureKit) of the show display — never Window Capture; **with a video meter-bounce**: a checklist step confirming OBS shows actual moving pixels (macOS permission resets can silently capture black — the video analogue of the 2026-06-28 silent set) **[show-ops]**. Encoder: VideoToolbox CBR (the recording doc's prescription). Cameras: wired USB at 1080p; if both cameras are kept, USB controller bandwidth is a rehearsal check.
- **Fallback: one-Mac (M2), fully budgeted**; `show.config` flips everything.

**Operator UX:** the CLI op is registered per Convention B (**`run_show`**, `@fluncle/registry` entry for any surface it exposes) **[canon]**. `fluncle run show`: arm + verify audio (meter bounces, across the transport), start the bridge, launch the pinned Chromium fullscreen on the show display (AppleScript placement + a **placement verification step and a re-place hotkey** — display IDs reorder on venue projectors **[show-ops]**), verify channels + flash limiter + watchdog, OBS via obs-websocket or handed to the operator.

**The pre-show checklist** (replaces the draft's; ordered, catastrophic-first **[show-ops]**): both laptops on mains → disk headroom both machines (~40 GB M5 / REC-WAV room M2) → FLX4 into the **M2** → Rekordbox PC MASTER OUT (never Aggregate) + 48 kHz → transport up, **M5 music meter bounces** → **mic present on the M5**, Track 2 clean → **OBS captures real pixels** (video meter-bounce; screen-recording permission verified after any update) + the glass fullscreen on the show display → DND/Focus on, notifications + display sleep off, update nags suppressed → channels green, flash limiter armed, watchdog alive, context-loss smoke passed, permissions confirmed (no dialog hiding behind fullscreen) → AV-sync profile loaded → **30-second Twitch test stream, zero dropped frames** → VideoToolbox + CBR confirmed → Rekordbox REC armed → cameras live.

**The dress rehearsal protocol (acceptance, not vibes)** **[show-ops]**: full-duration thermal soak on both machines (90+ min, frame rate and master-audio dropouts logged to the end); every failure injected live _while actually DJing_ — transport cable pulled, Chromium killed (time the on-air gap), camera yanked, limiters deliberately tripped, the combined single-cable fault; the deliverables produced and verified from the rehearsal recording (ffprobe track model, clean Track 1 with no AGC contamination, AV-sync checked in the file, PEAT on the composited output); a permission/update drift dry-run; a true cold-boot timing of `fluncle run show`.

## 6. Unit O — the set as one artwork (the offline hour render)

**The thesis, canon-first** **[canon]**: the hour video is the mixtape's fiction made visible — Fluncle dreaming, the set travelling through the findings' own worlds. Chapters are the findings' archived compositions; **transitions are travel between worlds** (directioned interstitials, not video dissolves — this settles the transition-language half of decision 6); the set-wide connective layer is **the dreamer's continuity**, and it is a _driver_, not a fig leaf **[taste]**: one set-level authored trajectory (palette/energy drift keyed to the StudioEnvelope) feeds every chapter, so the hour is a piece, not a playlist.

- **The identity layer is designed, not suppressed** **[canon — corrects the draft's global `hideOverlay`]**: each finding's Log ID surfaces at its mix-in in the fixed TypePlate grammar (scaled prescriptive timing; doubles as YouTube chapters), and the piece ends on a mixtape CloseCard carrying the `F`-marked coordinate. An hour of findings with no identity and no ending violates doctrine 4 and the Log ID spine.
- **Chapter mechanics, corrected** **[staff-eng S1]**: `<Sequence>` duration-scoping is real (verified) — but the actual defect is **absolute-second keyframes**: comps drive arc/close via `interpolate(sec, […, 20], …)`, which freeze at 20 s inside a 4-minute chapter (ignite-then-flatline). Chapter prep is therefore a **per-finding agent pass**: audit the comp for absolute-second drivers, rescale them to chapter length (or re-express on `u_progress`), verify with stills. This is the "thin connective authoring" of the hybrid thesis, priced honestly. The day-one spike renders a real comp _containing `u_rise`/`u_settle`-class drivers_ at chapter length and is judged on the freeze — not on Sequence scoping.
- **Per-chapter props are freshly analyzed** (set-audio slices through the existing `analyze-audio`; the StudioEnvelope is the macro-arc authority and the connective-trajectory driver, never the band source).
- **Render engineering, corrected** **[staff-eng S2]**: interstitial-clips + `-c copy` cannot crossfade (a blend needs both sources) — the draft's two mechanisms were mutually exclusive. The resolution is the standard Remotion-at-scale pattern: **one parent composition** (chapters + travel transitions + the connective trajectory, all inside Remotion, `calculateMetadata` summing), rendered in **`frameRange` chunks** — determinism makes chunk boundaries byte-consistent — concatenated with the concat demuxer. Chunked = resumable, parallelizable, QA-able per chunk; the grain never suffers a re-encode generation.
- **Encode/distribution:** landscape target per decision 2, VBV ~20–24 Mbit (the grain floor), bt709, ~9–11 GB/hour, R2 range-streamed (the `set.mp4` path) + YouTube. Compute: local Mac (2–3× realtime); the swangle box ruled out by arithmetic; Remotion license $0 at this team size; a GPU box is a later drop-in.
- **QA:** gates per chunk + flash on transition spans; **the arc gate recalibrated for chapter length** (the 20 s constants false-fail stretched arcs; feed the calibration corpus chapter-length verdicts); the whole-piece build judged off the StudioEnvelope.

## Sequencing & ownership

1. **Day-one de-risks (parallel, all cheap):** (a) the Unit O spike — a real comp with absolute-second drivers rendered at chapter length, judged on the freeze + the reflow (feeds decisions 2 and 6); (b) `osc-js`/Bun dgram verification; (c) the rkbx_link hardware verification on the real M2 (informs v2's shape; v1 does not depend on it).
2. **Critical path (live-first):** S (contract + emitter + the four defaults + canon palette set cleared through the real gates; the live-ready authoring rule lands in the fluncle-video skill) → L (the glass: rails, arrival moment, holding scene, controls) ∥ B (bridge v1: state, supervisor, matcher index, phone remote scaffold) → T (`fluncle run show`, the two-machine runbook as `docs/live-show-setup.md` — the sibling of the recording doc — checklist + rehearsal protocol) → **the dress rehearsal is the acceptance gate for the first show**.
3. **Parallel track:** O (agent-pass chapter prep → parent composition + travel transitions + dreamer's-continuity driver → chunked render orchestration → QA recalibration → one real mixtape shipped end-to-end).
4. **v2 (after shows prove v1):** rkbx_link on the wire → the matcher live → prefetch/arrival automation → phrase look-ahead. Each lands behind the same rehearsal discipline.
5. **Deploy discipline:** `packages/video` + `packages/live` via the normal PR flow; the scene.json upload is the three-file change (web + CLI); registry entries for any new surface.

## Decisions needed BEFORE handoff (six, each with a recommendation)

1. **v1 without rkbx_link — confirm.** The panel's case is strong (root memory-scraper on a re-signed core app on the machine the crowd hears, for identity the operator can cue manually and the tracklist recovers offline). Recommend: **yes, v1 manual + audio-novelty; run the hardware verification anyway** (cheap, shapes v2).
2. **The offline aspect fork:** landscape-first hour renders reusing the portrait archive (judged on the day-one spike's reflow), portrait output, or landscape re-composition in the chapter agent pass. Recommend: **landscape-first; let the spike render decide how much the agent pass must re-compose.**
3. **Audio transport:** analog splitter primary (buy the ~€25 interface), SonoBus configured-PCM as convenience. Recommend: **yes — splitter primary.**
4. **Uncharted-space palettes:** the hand-cleared canon set only, or derived pseudo-galaxy placement (BPM/brightness → the four vibe-map galaxies' territory)? Recommend: **derive within the canon-constrained set** — the majority path should feel placed, and the gamut stays ours either way.
5. **The venue feed:** does the house screen get the raw glass (HDMI from the M5) or the OBS program feed? Shapes display topology and the placement step. Recommend: **the raw glass on HDMI; the program feed is for the stream** — the room sees pure art, the stream sees the show.
6. **Taste calls on rendered evidence (operator-only):** the stretched-arc chapter render (does a re-driven world breathe at 4 minutes?) and the travel-transition language. Made on the spike outputs, not in the abstract.

Rulings recorded (not decisions — canon or evidence already answered): the Log ID surfaces on arrival (canon); live drops are detector-driven (the scripted-clock law); the runtime lives in `packages/live`; the CLI op registers as `run_show`; `certified`→`cleared`; blackout eases to the holding scene; no continuous hue rotation.

## Acceptance criteria

- **S:** schema + validator (+ the palette dark-ceiling check) with tests; the emitter (module-evaluating, `GLSL.*`-only interpolation guard, live-ready static scan) with tests; the three-file upload change; the four defaults + the palette set cleared through the real gates; the offline round-trip AND the live-replay proofs both pass; fluncle-video skill + packages/video README updated.
- **L:** the glass renders the default family + executes an arrival (palette/seed morph + Log ID moment) at the stream fps with all rails active; a recorded session passes PEAT (bare and composited); the context-loss smoke, watchdog relaunch, audio-loss → holding-scene, and guarded-blackout paths each demonstrated; 90-minute soak with flat memory.
- **B:** ShowState streams with health; the matcher resolves against the real archive; every failure-matrix row _including the single-cable fault_ demonstrated; the supervisor relaunches a killed renderer on-camera.
- **T:** `fluncle run show` cold-boots the two-machine rig; the checklist auto-verifies where possible (audio meter, video meter, permissions, disk, versions); the dress rehearsal protocol executed in full with deliverables verified from the recording; `docs/live-show-setup.md` written; registry + naming entries landed.
- **O:** one real mixtape rendered end-to-end (agent-passed chapters, travel transitions, dreamer's continuity, Log ID moments, `F`-coordinate CloseCard), QA'd per chunk with the recalibrated arc gate, published via set.mp4 + YouTube with chapter markers; the calibration corpus extended.
- Tests and documentation are inside every unit, not appended after.

## Risks & open questions

- **rkbx_link (v2)** remains the largest operational commitment — re-signing, root, version pinning; mitigated by being v2, hardware-verified early, and rehearsed.
- **The flash limiter has no published prior art** — first-principles from verified thresholds; PEAT-validated before the first show; labeled honestly.
- **Chrome/macOS drift**: pinned runtime + permission dry-runs; the checklist verifies, the pinning remedies.
- **The stretched-arc taste risk** and **the reflow question** are settled by the day-one spike before the chapter pipeline is built.
- **M2 contention is modeled, not measured** — a five-minute probe on the real M2 with Rekordbox + OBS live is part of the first rehearsal.
- **Honest horizon:** whether the glass reads as _the journey_ rather than a very good VJ wall is a taste outcome — the arrival moment and the holding scene are the design bets that make it Fluncle; they get first-class attention, not leftover time.

## Appendix — verifications & sources

- **Spike (2026-07-03, operator's rig):** production GLSL header + default vehicles live at locked 60 fps; BlackHole captured (`permission: granted`); meters verified against real Rekordbox master audio. Perf traps found/fixed (canvas realloc, DPR, WebAudio sink, silence-guarded morph).
- **Measurements (M5 Pro, Chrome 149/ANGLE Metal, vsync off):** ≈1.11 ms fixed + 0.067 ms/MP; 1080p ≈ 1.25 ms; crossfade +5%; DSP 0.016 ms; vsync locks 60 at all scales.
- **Panel verifications (staff engineer, live):** 5/6 shipped comps drive arcs via JS custom uniforms (`012.2.4L` `u_rise`/`u_settle` interpolations, lines 118/178/200/208/240); all frag interpolations are bare `GLSL.*` refs; `bloom` in 5/6, `reactivity` in 6/6; the #254 precedent commit touched 3 files (+51); `CORE_UNIFORMS` parity confirmed; `<Sequence>` duration-scoping confirmed (Remotion 4.0.481 docs); `SMOOTHED_BANDS`/`MOTION_AXES` exist but govern only the translation axis.
- **CORS on found.fluncle.com verified live** (`access-control-allow-origin: *`); props.json/artwork browser-fetchable.
- **Channel research (sources in the research pack):** rkbx_link OSC schema + macOS re-sign/sudo/7.2.8 pin; PRO DJ LINK dead in performance mode; JS Ableton Link bindings unmaintained; osc-js UDP↔WS bridge mode (Bun dgram = day-one verification).
- **Flash safety:** WCAG 2.3.1 normative math (W3C); Xbox XAG-118 (2026-06-17); Jordan & Vanderheiden (ACM TACCESS 2024); UK HSE ≤4 Hz; HardingFPA/PEAT as offline calibration.
- **OBS/macOS:** ScreenCaptureKit display capture; Window Capture documented non-performant; VideoToolbox on the Media Engine (CBR since OBS 28); Sequoia screen-capture permission resets; getUserMedia default processing (AGC/NS/EC) documented.
- **Remotion:** frameRange-chunked rendering of one composition (the Lambda pattern) enables `-c copy` concat without a re-encode generation; license $0 ≤3 people self-hosted.

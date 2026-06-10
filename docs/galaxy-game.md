# Fluncle's Galaxy — the game

> **Living notes + resolved direction, not yet code.** The core design was settled in a grilling session on 2026-06-10; everything under "Confirmed decisions" is decided, and "Open threads" is what's genuinely still loose. Canon (DESIGN.md / PRODUCT.md / VOICE.md) and the codebase still arbitrate on any conflict.

## The pitch

An oldskool, 8-bit space game where you fly Fluncle's galaxy and collect bangers. It lives on **fluncle.com** (the full, sensory version); the **SSH terminal** at `ssh rave.fluncle.com` gets the audio-less flex later. The galaxy is literally made of our findings: **every banger is a star, placed at its Log ID coordinate.**

Boot the game → an opening animation of Earth with a spaceship taking off → cut into gameplay. You're now piloting the ship: continuous cruise, **steer left/right** only, **boost to go faster**. The view is behind-the-ship: your 8-bit ship sits low-center while stars stream past and around it with parallax depth. You burn **fuel** constantly (boost gulps it). The only refuel points are **star coordinates** — bangers — and **Earth**. A **radar scope (bottom-right)** shows bearing blips for every uncollected star in range, so flying is route-planning: chase this one and the others fall off the edge. Get close enough to a star and you **log the banger**; the HUD ticks your tally (`3/22 bangers`). Run out of fuel and you restart on Earth at `0/N`. Collect them all, fly home, and you win.

The signature mechanic: as you approach the nearest uncollected star, its **30s preview fades in** by distance (and pans by bearing); turn away and it fades back out. You're flying toward a sound until it resolves into a banger — Fluncle's whole thesis as a game loop. And the galaxy is otherwise silent: the only music out there is the findings themselves.

## Why it works (the canon was built for this)

- **The Log ID is already a coordinate.** `sector.orbit.mark` (e.g. `007.8.1B`) deterministically places a star — the brand metaphor _is_ the mechanic, not a skin over one.
- **Music-first becomes the core loop.** Discovery = flying toward a faint banger until it resolves. The fade-in is the product pitch made playable.
- **Evolving playlist = evolving galaxy.** New bangers are new stars; replay value with zero per-user state. The galaxy grows as Fluncle finds more — see "The expanding galaxy" below.

## The expanding galaxy (the frontier fiction)

The Log ID sector is days since the Fluncle epoch (2026-05-30), and the placement mapping reads it as **distance from Earth**: the oldest findings orbit close to home, and every new finding pushes the frontier outward. The galaxy literally expands as Fluncle travels — just like ours.

**Deliberately uncompressed.** We do not squash the radius as sectors climb. A full clear getting longer over time is not a bug to engineer away; it is the literal source of the game's expansion content. As the frontier pushes out, the journey from Earth gets too long — and that pressure is what future things answer:

- **Other planets as new homes** — forward bases / respawn + refuel hubs out in later sectors, so deep runs don't start from Earth.
- **Asteroids** — hazards in the long empty stretches between eras.
- **Black holes** — danger, or warps that shortcut the old sectors.
- **Aliens / UFOs** — encounters; the further out, the stranger.
- Easter eggs, lore nodes, derelicts — the deep frontier gets weird.

The rule of thumb: **the further from Earth, the stranger the universe.** Near space is the warm, familiar early catalogue; the frontier is new-and-scary (the PRODUCT.md flicker: "we'll handle it, and it'll probably be a laugh"). Expansion features should be motivated by outward growth, not bolted on.

Stars sharing a sector (found the same day) share an orbital ring, spread by their hash angle.

## Confirmed decisions

### Camera & feel

- **Behind-the-ship horizon view** (Star Fox / Out Run in space): 8-bit ship sprite low-center, stars stream past with parallax depth, some above and below. Gameplay space is a 2D plane (steer = rotate heading); the depth is visual.
- **Parallax pseudo-3D**, not true 3D — projected starfield, cheap, gives the feel.
- **Deterministic galaxy.** Placement is pure function of Log ID, so every run is the same map — map knowledge carrying across deaths IS the skill curve.

### Fuel & stakes

- **Fuel always burns**: cruise sips, boost gulps. The tank is a ticking clock; every detour costs.
- **Refuel at uncollected stars and at Earth.** Earth is home and always refuels — which also makes the fly-home ending mechanically safe.
- **No softlocks by construction**: the placement mapping guarantees every star is within one tank of some refuel point.
- **Run dry → death drift**: engines die, instruments flicker out, the ship drifts a couple of beats ("…recovered adrift. Towed home."), restart on Earth at `0/N`.
- **Target run length: 10–15 minutes** for a competent full clear at today's catalogue size. This number tunes star spacing, cruise speed, and burn rates.

### Radar & navigation

- **Bearing + signal strength, multi-blip.** The scope shows a directional blip for every uncollected star in range — not just the nearest — so the player makes route decisions (go left for that star and the others fall off the radar). Strength readout for the nearest carrier.
- Audio fade/pan confirms the bearing; the radar makes navigation legible, the audio makes it sing.

### The listening moment

- Reaching a star logs the banger: a small log card pops (`fluncle://<id>` · Artist — Title), the tally ticks.
- **Refueling is deliberately slow** — slow enough that you sit in orbit while the tank fills, and the 30s preview loops at full volume. You collect it, then you actually hear it. Ceremony through mechanics, not a cutscene.
- **Collected stars stay audible on revisit** (fly back and listen any time); only the radar/refuel logic ignores them. The "nearest uncollected" culling governs the hunt, not the listening.

### Win & death

- **Win = fly home.** At `N/N` the radar goes quiet ("no carriers left in the sector"), Earth becomes the final blip, and landing rolls the endscreen: the full log, every banger collected.
- **N is fixed at boot.** A banger logged mid-session becomes a new star on the next run, never a moving goalpost.
- **Session-only state.** No persistence in the MVP; user accounts (persistent collection) stay a Later roadmap item.

### Controls

- **Desktop:** left/right steer, hold to boost (spacebar).
- **Touch from day one:** thumb zones left/right to steer, a hold-to-boost zone (bottom-center), HUD sized for phones. No tilt steering. Don't overdo it.

### Look & sound

- **Canon-anchored 8-bit ramp**: a small NES-style palette built from canon — warm blacks, Starlight Cream ramp, Eclipse Gold ramp, Re-entry Red heat, plus 2–3 dim cool counter-accents per the Retint Rule for variety in stars/planets. Reads 80s AND unmistakably Fluncle.
- **Bangers are the only music.** Deep space is silent except diegetic 8-bit SFX: thrust hum, radar ping, log chime, fuel alarm. Approaching a star is the only time the void sings — the thesis, made literal.
- **Sprites, first slice: two heroes.** The ship and Earth, made genuinely great via the image-gen pipeline (Gemini "Nano Banana"; `GEMINI_API_KEY` lives in the Kaulobot 1Password vault, via `op`), plus procedural stars. The menagerie (asteroids, UFOs, planets) is its own later session.
- **Boot animation v1 is minimal and skippable**: Earth sprite, ship lifts off, stars streak, title plate ("FLUNCLE'S GALAXY" — a sanctioned brand-mark plate per VOICE.md), cut to gameplay. The full cinematic comes later.

### Voice

- **HUD speaks instrument telemetry** even on web — the Depth Gradient says density rises as you descend, and a cockpit is deep: "carrier detected… 71%… LOCK", "tank dry in 00:43". Drier than the archive page, not as far gone as SSH. Run game copy through the copywriting-fluncle skill.

### Hosting & plumbing

- **Build inside `apps/web` as a route**, code-split so the archive stays fast; attach `galaxy.fluncle.com` to the same Worker as a custom domain serving that route. Same-origin keeps API + audio proxy trivial (no CORS, no second deploy pipeline). A separate Worker buys isolation we don't need yet.
- **Audio via a Worker proxy** (`/api/preview/:trackId`, re-resolving on demand): `previewUrl` is already on `/api/tracks`, but Deezer URLs carry expiring tokens and the Deezer CDN won't grant the CORS that Web Audio's gain/pan graph needs.
- **Don't hard-bind to Deezer.** Previews will soon live in our own R2 bucket; the game must read whatever `preview_url`-shaped source the API hands it (own R2 URL, proxied Deezer, whatever) without caring which.
- Web Audio: gain + stereo-pan the single nearest uncollected banger by distance + bearing; loggable stars are spaced so audio never overlaps. Playback gesture-gated by the boot screen (autoplay policy).
- Audio policy unchanged: web playback uses official previews (or our own R2 copies of them), never YouTube (see the roadmap's audio policy).

## The first slice (foundational work)

- **Deterministic star placement from the Log ID**: sector → distance from Earth (the frontier mapping above), hash → angle; same-day stars share a ring. Plus the reachability guarantee (every star within one tank of a refuel point).
- **Flight loop**: steer / boost / fuel-drain / cruise; behind-the-ship parallax starfield render (canvas/WebGL).
- **Proximity**: per-star distance → multi-blip radar; nearest uncollected → Web Audio gain & pan via the preview proxy.
- **Refuel (slow, at stars + Earth) + log card + tally + fly-home win + drift-death restart.**
- **Boot animation** (minimal, skippable) and the two hero sprites.
- **Touch + keyboard input** from day one.
- Build the world **data-driven** (entities placed in the field) so frontier content (planets, asteroids, black holes, UFOs) slots in without re-architecting.

## Surfaces

- **Web** — `apps/web` (canvas/WebGL game + Web Audio). The full sensory version. **This first slice is web-only.**
- **SSH** — `apps/ssh` (Go TUI), explicitly out of the first slice. Carries the whole game minus audio, with proximity as signal-strength telemetry (`carrier detected… 71%… LOCK`) — a lonely operator reading instruments, not hearing the song. Limitation as flavor. Confirm realtime input + frame rate over SSH when we get there.

## Open threads (flesh out later)

- Exact placement math: radius units per sector, ring spread, minimum star spacing for audio culling; where the one-tank reachability constraint bends placement.
- Economy tuning numbers: burn rates (cruise vs boost), tank size, refuel rate (slow enough to hear ~one loop of the preview?), cruise/boost speeds — all in service of the 10–15 min clear.
- Endscreen design: what the full-log victory screen actually shows.
- Sprite specs for the gen pipeline: resolution, palette enforcement, how sprites are stored/served.
- SSH slice timing and feasibility check.

## Relationship to the rest of the roadmap

- Shares the **Log ID spine** with the [logbook reframe](./ROADMAP.md) (stars _are_ log entries) — the game is a surface of Fluncle's Galaxy.
- **Motivates user accounts** (persistent collection / progress) — tracked separately as a Later roadmap item, explicitly **out of scope** for this MVP.
- Leans on the same **official-preview audio policy** as the web Stories feature; the planned **own-R2 preview hosting** serves both.

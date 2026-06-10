# Fluncle's Galaxy — the game

> **Living notes + rough direction, not a spec.** A parking spot for the concept and decisions so a dedicated build session starts warm. To be fleshed out later. Canon (DESIGN.md / PRODUCT.md / VOICE.md) and the codebase arbitrate on any conflict — this is brainstorm, like the other planning docs.

## The pitch

An oldskool, terminal-UI space game where you fly Fluncle's galaxy and collect bangers. It lives on **fluncle.com** (the full, sensory version) and inside the **SSH terminal** at `ssh rave.fluncle.com` (the audio-less flex). The galaxy is literally made of our findings: **every banger is a star, placed at its Log ID coordinate.**

Boot the game → an opening animation of Earth with a spaceship taking off → cut into gameplay. You're now piloting the ship: continuous cruise, **steer left/right** only, **spacebar accelerates**. The galaxy reads 3D (stars above and below) via parallax, but you only steer on one axis. You burn **fuel**. The only way to refuel is to fly to a **star coordinate** — a banger. A **radar (bottom-right)** shows how close you are to the nearest loggable star. Get close enough and your fuel refills and you **log the banger** (collect it). The HUD shows your tally: **`1/17 bangers`**. Run out of fuel and you restart on Earth at `0/17`. Collect them all and you win.

The signature mechanic (web): as you approach the nearest uncollected star, its **30s preview fades in** by distance (and pans by bearing); turn away and it fades back out. You're flying toward a sound until it resolves into a banger — Fluncle's whole thesis as a game loop.

## Why it works (the canon was built for this)

- **The Log ID is already a coordinate.** `sector.orbit.mark` (e.g. `007.8.1B`) deterministically places a star — the brand metaphor _is_ the mechanic, not a skin over one.
- **Music-first becomes the core loop.** Discovery = flying toward a faint banger until it resolves. The fade-in is the product pitch made playable.
- **Evolving playlist = evolving galaxy.** New bangers are new stars; replay value with zero per-user state. The galaxy grows as Fluncle finds more.

## Confirmed decisions (this session)

- **Web-first, SSH second.** Web is where you hear it and lose your mind; SSH is the flex that it's playable in a terminal at all.
- **Parallax pseudo-3D**, not true 3D — projected starfield, steer = rotate heading, stars stream past, some above/below. Cheap, gives the feel; we have shader chops from the video kit.
- **SSH has no audio** (it's a byte stream — the server can't play your speakers). SSH carries the _whole game minus audio_, with proximity rendered as **signal-strength telemetry** (`carrier detected… 71%… LOCK`). That fits the "recovered terminal" voice — a lonely operator reading instruments, not hearing the song. Limitation as flavor.
- **Cull audio to the nearest star.** Loggable stars are spaced far enough apart that audio shouldn't overlap; gain + stereo-pan the single nearest uncollected banger by distance + bearing (Web Audio).
- **Collect = log the finding.** Flying into a star logs it; pops a small log card (`fluncle://<id>` · Artist — Title) and ticks the tally. Wires the game straight into the logbook spine instead of being a separate toy.
- **Session-only state.** No persistence in the MVP — refresh or run out of fuel and you start over. Win = collect all _currently-listed_ bangers; `N` is fetched at boot and fixed for the session.
- **Art style: 8-bit.** Sprites (the ship, and later everything else) generated with image-generation models (OpenAI's `gpt-image`, Google's "nano banana" / Gemini image), then curated to a tight 8-bit palette/aesthetic.

## The world — a canvas to hide things in

MVP entities: **Earth** (start), **banger stars** (loggable / refuel), the **ship**, **fuel**, **radar**. Build the world **data-driven** (entities placed in the field) so future things slot in without re-architecting. The fun part is everything we can scatter later: **asteroids** (hazards?), **black holes** (hazards / warps?), **UFOs** (encounters / events?), **other planets** (hubs / lore?), easter eggs, lore nodes. This first slice should focus on the _foundation_ — a fun, captivating loop — not the toys.

## The first slice (foundational work)

- **Data plumbing (the real first brick):** expose `{ logId, artist, title, previewUrl }` per track to the client. Previews are resolved server-side today (Deezer/iTunes, `resolve-preview.ts`) but are not on `/api/tracks` — they need exposing (or storing). Policy-clean: web playback on official previews is the sanctioned published-audio path (never YouTube — see the audio policy in the roadmap).
- **Deterministic star placement from the Log ID.** Map `sector.orbit.mark` → position (design the mapping — e.g. sector = era / frontier distance from Earth, the hash = angular spread).
- **Flight loop:** steer / accelerate / fuel-drain / cruise; parallax starfield render (web canvas or WebGL).
- **Proximity:** nearest-star distance → radar + (web) Web Audio gain & pan, (SSH) signal readout.
- **Refuel + collect + tally + win + restart-on-empty.**
- **Boot animation:** Earth → takeoff → cut to gameplay.

## Surfaces

- **Web** — `apps/web` (canvas/WebGL game + Web Audio). The full sensory version.
- **SSH** — `apps/ssh` (Go TUI; tcell / Bubble Tea, raw-mode realtime input). Audio-less; signal telemetry. Confirm realtime input + frame rate over SSH early.

## Open threads (flesh out later)

- Star-placement mapping: how exactly Log ID → `(x, y, z)`; does `sector` map to distance from Earth (frontier feel)?
- Game economy: fuel burn rate, cruise/boost speed, refuel rate, galaxy scale + star spacing (keep audio non-overlapping).
- 8-bit art pipeline: which model, sprite specs, palette, how sprites are stored/served.
- Endgame feel: what "you win" shows.
- Audio delivery: store preview URLs vs resolve on demand; caching; CORS for Web Audio.

## Relationship to the rest of the roadmap

- Shares the **Log ID spine** with the [logbook reframe](./ROADMAP.md) (stars _are_ log entries) — the game is a surface of Fluncle's Galaxy.
- **Motivates user accounts** (persistent collection / progress) — tracked separately as a Later roadmap item, explicitly **out of scope** for this MVP.
- Leans on the same **official-preview audio policy** as the web Stories feature.

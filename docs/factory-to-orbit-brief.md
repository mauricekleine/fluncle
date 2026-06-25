# Brief: From Earth to Orbit — the track's journey as one living world

**Status:** Brainstorm. Non-canonical (a `*-brief.md`): vision + planning, never spec. Where this deviates from the codebase or canon (`DESIGN.md`, `PRODUCT.md`, `VOICE.md`), the code and canon win — translate the idea into Fluncle's terms when picking it up.

**The spark (two ideas that turned out to be one):** a `/factory` page where a new finding rides a full-screen conveyor through the real production pipeline, and a per-track sprite you can _collect_. Following each idea to its end, they meet: the factory's finished tracks are **launched into orbit**, and orbit is where you **fly around and collect them**. That's not two features — it's the missing middle of a single arc.

## The through-line: a finding's life, made playable

Fluncle already has a real lifecycle (`docs/track-lifecycle.md`): a **fast synchronous add**, then **async enrichment** (audio analysis, context note, editorial note, observation, video render, R2), then **publish** (Spotify, Telegram, the video channels, the newsletter), then **social-capture** of the live URLs. Today that arc is invisible — it happens in Workers and on-box crons. The vision makes the arc **the product**:

> **Found** (on Earth) → **assembled** (the Factory line) → **launched** (into orbit) → **collected** (in the Galaxy).

Three views of one world, joined by one object travelling through them — and the **sprite system** (`@fluncle/sprites`, the `fluncle-sprites` skill, `/sprites`) is the shared visual language that makes them feel like one place. Earth is the **ground** (the surface map, `docs/earth-overworld.md`); the Factory is the **line** (how a finding is made); the Galaxy is the **sky** (`/galaxy` — where finished findings live as collectible stars). A finding starts on the ground, gets built on the line, and is launched up to join the others.

## Idea 1 — `/factory`: the assembly line (near-realtime)

A long, left-to-right, full-screen **conveyor in a factory environment**. A finding enters on the **left** the moment it's added and rides the belt through a **station per lifecycle stage**, each a distinct piece of **machinery** (= a distinct sprite — the sprite system's first big payoff beyond icons):

| Station (machine)       | Lifecycle stage it visualizes                                             |
| ----------------------- | ------------------------------------------------------------------------- |
| Intake hopper           | the fast synchronous add                                                  |
| Spectrograph / analyser | audio analysis (BPM, key, the spectral fingerprint)                       |
| Press / stamp           | the context note + editorial note (the facts + the written note)          |
| Recording booth         | the spoken observation                                                    |
| Render bay              | the video render (the `rave-03` box)                                      |
| Dispatch dock           | publish — Spotify + Telegram + the video channels + newsletter            |
| Address printer         | social-capture (the live YouTube/TikTok URLs written back)                |
| Launch pad              | the finished finding → loaded into a small ship → **launched into orbit** |

**Queues are the point.** A station only processes so fast, so findings **pile up** in front of the slow ones — e.g. several findings waiting on the **render bay** stack in its in-tray. That pile _is_ the real backlog (the render queue, the enrich queue), made physical and honest. You can see at a glance where the line is congested.

**The state is real, not faked.** Each finding's position on the belt is derived from its actual enrichment/publish state (the same fields `/status` and the admin board read). The factory is a _renderer of true state_, not a cosmetic animation.

**Realtime.** Start with **polling `/api/tracks`** (near-realtime, zero new infra — the public read already carries the state). Graduate to **WebSockets via a Cloudflare Durable Object** if we want true push (a finding _snapping_ onto the belt the instant it lands). Poll-first keeps this shippable.

**Inspection.** New-finding **indicators** ("3 incoming") at the left edge; the user **drags left** (or an arrow key / `a`) to scroll back along the belt and watch a fresh finding arrive and move through. It's a calm, ambient, inspectable surface — the opposite of a dashboard.

**The exit is the bridge.** A done finding leaves screen-right, gets loaded into a tiny ship, and **launches** — the literal mechanism by which a track goes from Earth into orbit. The Earth game already has a rocket→`/galaxy` bridge (`docs/earth-overworld.md`); the Factory generalises it: _every_ finished finding makes that trip, automatically.

## Idea 2 — a sprite per finding, and a collection

Once the sprite pipeline is trustworthy (the pilot → fan-out we're about to run), add an **automation: generate a sprite for every track** — its own little pixel object, on the same fixed rails as everything else (so it belongs), but a _unique subject_ per finding. The obvious seed: the finding's **cover art + its vibe** (the energy×mood placement / the four galaxies from `/admin/tag`) → a sprite that _is_ that track. (This is the one place we deliberately want **variety inside the consistency** — same grid/palette/light, different creature.)

Then it becomes **collectible**:

- In the **Galaxy game**, each finding is a star/sprite you fly up to and **collect** (the galaxy already has a server-side, Log-ID-keyed progress store — `apps/web/src/game/progress.ts`).
- A **collection page** — a binder, the way people kept Pokémon cards or Flippos: a sheet of slots, **empty outlines** for the uncollected, the **full sprite** filling in on collect. The dopamine of the gap closing.
- This is where **user accounts** finally earn their keep: public profiles that show **which stars/sprites/findings each person has collected**. (Today auth is operator-tier — Login with Spotify; this introduces _public_ accounts, plausibly the same Spotify OAuth, so a fan's collection is theirs.)

## How Earth, the Factory, and the Galaxy co-exist

Open question, and we cross it when we get to it — but the brainstorm: are these **three dimensions of one game/platform** (you move between the ground, the line, and the sky), or **separate surfaces** that share a world and a save? The through-line argues for _one world_: a finding is the same object in all three, the sprite system is the shared language, and the progress store already round-trips between them. The cleanest mental model:

- **Earth** = the ground / the surface map (where Fluncle exists on the web).
- **The Factory** = the underworld / the works (how findings are made) — reachable _from_ Earth (a door in the Workshop?).
- **The Galaxy** = the sky (where finished findings live and are collected).

…with the **launch** as the one-way valve from line to sky, and the rocket on Earth as the player's own way up. Whether they literally share a canvas or just a save is an implementation call for later; the _narrative_ is already one.

## What we already have (the foundation this stands on)

This is mostly **connective tissue over things that exist** — which is why it's not insane:

- **The sprite system** — `@fluncle/sprites` (the asset + manifest + `spriteUrl` + the `renderToAnsi` CLI hook), the `fluncle-sprites` skill (the generate→snap→quantize pipeline), `/sprites` (the inventory). The machines and the per-track sprites are this pipeline's reason to exist.
- **The track lifecycle** — `docs/track-lifecycle.md` + the on-box crons (enrich, context-note, note, observation, render, social-capture). The Factory's stations _are_ these stages; the state is already exposed on `/api/tracks` and `/status`.
- **The Earth overworld** — `/earth` (`docs/earth-overworld.md`): the ground, the surface-map, the rocket bridge — shipped, noindexed, swappable sprites.
- **The Galaxy game** — `/galaxy` + the Log-ID progress store: the sky, and the collection substrate.
- **Auth** — operator-tier Login with Spotify today; public accounts are the increment the collection needs.

## What it needs (the honest open threads)

- **Realtime mechanism** — poll `/api/tracks` first; Durable-Object WebSockets if we want push.
- **The Factory data contract** — expose each finding's per-stage state cleanly (it mostly exists; may want one tidy `/api/factory` view).
- **Per-track sprite generation** — the automation (a cron in the lifecycle), the _subject_ derivation (cover + vibe), storage (R2 / the package?), and the galaxy/collection rendering. Variety-within-consistency is the real design problem.
- **Public user accounts + profiles** — the biggest genuinely-new system; everything else is built on what we have.
- **Scope & phasing** — this is a multi-quarter arc, not one build. A sane order: (1) lock the sprite pipeline, (2) `/factory` as a poll-driven renderer of real state (huge demo value, low new infra), (3) per-track sprites as an automation, (4) public accounts + the collection, (5) the Earth/Factory/Galaxy unification.

## Why it's coherent (not insane — genius's close cousin)

It lands every Fluncle north star at once: it's **music-first** (a finding is the hero of its own little assembly line and its own collectible), it's **the Nostalgic Cosmos made literal** (the ground, the works, the sky), it deepens **the canon narrative** (the traveller's findings, sent back across the Galaxy — now you watch them get _made_ and _launched_), and it's a **reach engine** — a reason for fans to come back, collect, and have a profile worth sharing. The factory turns invisible infrastructure into a thing people _want to watch_; the collection turns a passive archive into something you _own a piece of_. That's the whole point of the project — how far the tentacles stretch — expressed as play.

> 🫡 It's all coming together.

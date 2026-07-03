# Live show setup — the two-machine rig, the glass, and `run show` (macOS)

Your pre-flight before you go live behind the decks with visuals: how to wire the two-machine rig, put Fluncle's journey on the show display through the glass, stream to Twitch, and come out with the same clean masters the mixtape pipeline expects. This is the live sibling of [mixtape-recording-setup.md](./mixtape-recording-setup.md) — that doc owns the OBS 3-track model, the encoder, the 48 kHz chain, and the "PC MASTER OUT good, Aggregate Device bad" rule; this doc owns everything the live visuals add on top and does not restate what lives there. The architecture and the reasoning behind every choice is the RFC, [docs/live-longform-visuals-rfc.md](./live-longform-visuals-rfc.md) (Unit T is this rig). Once you have the recording, [`fluncle-mixtapes`](../packages/skills/fluncle-mixtapes) takes it from there.

## The one rule that matters

**The audio the glass reacts to is the same audio OBS records is the same audio the crowd hears — and it is analog.** In the two-machine rig the FLX4's master leaves as a physical signal and is split by the M-Track: one leg feeds the monitors, one leg goes down USB to the streaming machine, where OBS and the glass both read it. No BlackHole, no Aggregate Device, no network in the audio path. If the glass is dancing to something OBS did not record, or the speakers hear something the glass did not, the split is wrong — fix it before you play (the automated meter-bounce in `run show` catches the common case; the video meter-bounce in the checklist catches the other).

## The topology

Two machines, each with one job. This is the primary rig; the one-Mac fallback is below and `run show --one-mac` flips it.

- **M2 (the mixing machine):** Rekordbox + the DDJ-FLX4 + Rekordbox REC. Genuinely nothing else — no OBS, no browser. It plays the set and cuts the belt-and-braces WAV master.
- **M5 (the streaming/recording machine):** the glass (the WebGL runtime), the bridge (plan + fingerprint identity + the watchdog + the phone remote), OBS (the Twitch stream + the `.mov` master), the mic, and the camera(s). `run show` lives here.

## Signal flow (what "wired correctly" looks like)

```
M2  Rekordbox (master) ─► DDJ-FLX4 ─► headphone cue (you cue on the controller)
                                    │
                                    │ MASTER OUT (RCA)   ── 2× RCA→TS cables ──┐
                                    ▼                                          ▼
M5  M-Track Solo   in 1 (combo, center) + in 2 (LINE switch)   ◄──────────────┘   phantom OFF · gains ~noon
        │  DIRECT monitor (zero-latency analog pass-through — the speakers hear exactly what they always did)
        │  MAIN OUTS (RCA) ── 2× RCA→TS ─► BX5 monitor speakers
        └  USB-B ─► M5
M5  M-Track (48 kHz USB input)
        ├─► OBS "Audio Input Capture" ─► Tracks 1 + 3     (the music master)
        └─► Chrome getUserMedia        ─► the glass DSP    (the visuals react to the same signal)
    mic (built-in / Continuity, or Scarlett Solo) ─► OBS "Mic/Aux" ─► Tracks 2 + 3
   ⇒ Track 1 = clean music   Track 2 = clean mic   Track 3 = music + mic (Twitch)
```

The M-Track **is** the splitter — no Y-cables. It line-captures the FLX4 master, passes it straight through to the monitors on DIRECT, and presents it to the M5 as a single 48 kHz USB input that both OBS and Chrome read. Multi-client reading of one input device by OBS + Chrome at once is a rehearsal check (below), not a given.

## Setup (one-time)

### 1. The M-Track Solo, inline

- **FLX4 MASTER OUT (RCA) → M-Track inputs 1 + 2**, via the two RCA→¼" TS cables. Input 1 on the combo jack with its switch **centered** (line); input 2 with its **LINE** switch set. **Phantom power OFF** (it is a line signal, not a mic). Input gains around **noon**, then trimmed so the meter sits healthy without clipping.
- **Monitor switch on DIRECT** — the M-Track passes the inputs to its outputs with zero latency, so the speakers hear the master exactly as before; the USB round-trip never touches what the room hears.
- **M-Track MAIN OUTS (RCA) → the BX5 monitor speakers**, via the second RCA→TS pair.
- **M-Track USB-B → the M5.** In macOS the device shows up as a 48 kHz stereo input. It caps at exactly 48 kHz, which is the chain rate — nothing to set, nothing to drift.
- To buy if missing: one RCA→(TS or XLR, to match the speakers' inputs) pair and a USB-B cable (~€10–15). The existing FLX4→M-Track RCA→TS pair covers the input side.

### 2. OBS on the M5

Follow the recording doc's **3-track model** unchanged, with these live-rig substitutions:

- **Audio Input Capture → Device = the M-Track**, not BlackHole. The music arrives as a real analog input on the M5; there is no BlackHole/PC MASTER OUT trick in the two-machine rig (that is the one-Mac software path, below). Route it to **Tracks 1 + 3** exactly as the recording doc prescribes.
- **Mic/Aux → the mic on the M5** (built-in or the Continuity iPhone mic suffices; a Scarlett Solo is the option if you want an external one). Route it to **Tracks 2 + 3**, keep it clean (noise gate / sensible monitoring) per the recording doc.
- **Video: the program shot is the overhead camera; Display Capture is the optional crisp source.** The glass reaches the stream optically by default — the camera films the screen (see "Scene composition" below). If you add the direct-capture scene, it is **OBS Display Capture (ScreenCaptureKit) of the show display** — never Window Capture, which macOS documents as non-performant.
- Encoder, bitrate, resolution, recording format, sample rate: **all exactly as the recording doc specifies** (dedicated Apple VT H264 hardware encoder, CBR, 1920×1080, `.mov`, 48 kHz end to end). Do not re-derive them here.

### 3. The glass and the bridge

They come up under `run show` (next section) — you do not launch them by hand. For reference: the glass is a pinned Chromium serving the WebGL page on `http://localhost:4173`; the bridge serves the plan + the state stream on `http://localhost:4180` and hosts the phone remote at `http://<lan-ip>:4180/remote`. Both are LAN-local by design — no public surface, nothing in `@fluncle/registry`, nothing reachable off the network (the never-crash rail: the show has no network dependency mid-set).

### 4. The show display and the cameras

- **The show display** is whatever the glass takes over: the office rig is a small **Arzopa portable display** hung off the M5, filmed by an overhead **Continuity Camera iPhone** for the vertical social clips, while OBS streams the composited feed to Twitch. A real-venue big screen is the same HDMI port on the M5 — the architecture already supports it, it is not a separate setup.
- **Cameras** pair with the machine running OBS (the M5). The overhead Continuity iPhone survives a full set today; wired USB is the documented fallback if a rehearsal ever shows drops. If you keep two cameras, USB controller bandwidth is a rehearsal check.

### Scene composition — the optical shot is the signature

The signature look is deliberate: the overhead iPhone films the **physical scene** — the Arzopa glowing with the glass, the FLX4, your hands on it. The glass reaches the stream **optically**, a screen filmed by a camera, and that is the point: the shot picks up the room, the moiré, the glow spilling onto the deck — the Light-Years Rule happening in real life, the journey arriving lossy because of how it travelled. This shot is the default program, and it is where the vertical social crops come from.

Build one scene collection with two scenes:

- **The overhead scene (default / program):** the Continuity iPhone framing the Arzopa + FLX4 + hands. This is the stream's home.
- **The glass scene (the cut-to):** the pixel-crisp Display Capture of the show display — full-bleed glass, no room. Cut to it when the moment earns it (a big drop, an arrival) and cut back; it can also sit as a full-bleed layer under the overhead shot if a composite ever reads better.

The rehearsal is where you feel out the cuts — how long the glass scene holds before the room is missed, whether a drop wants the cut at the impact or a bar early. That is a taste call made on the stream, not in this doc. Whichever scenes you run, the video meter-bounce below applies to each source in them: a scene that composites a silently-black capture looks fine in the preview list and ruins the set.

## `run show` — the orchestrator

Canonical invocation (this is a **local orchestration**, not a `fluncle` CLI command — see [naming-conventions.md §7](./naming-conventions.md#7-local-exec-ops-the-registrys-non-http-tail); the registry op is `run_show`):

```bash
bun run --cwd packages/live show --plan <logId>
```

It brings the rig up in order and holds it up until you stand it down:

1. **Pre-flight** — reads the automatable checks and prints each as a deadpan status line (`[clear]` verified · `[hold]` a blocker · `[dark]` unreadable here): the **audio meter-bounce** (captures the M-Track input for 3 s and confirms the RMS actually moved — a dead route or a silent deck holds the launch), **48 kHz** on the input where the system will tell us, **disk headroom** (~40 GB floor), and **port availability** (4173 + 4180 free). A `[hold]` stops the launch unless you pass `--force`.
2. **The bridge** — starts it, waits for `/plan` to answer and the state socket to open.
3. **The glass** — starts the server, waits for the page.
4. **Chromium on the show display** — launches the pinned Chromium `--app` fullscreen with the RFC §3 flags (no backgrounding/throttling of an occluded show, its own profile), runs `caffeinate -dis` alongside to hold the machine awake, then **places the window on the show display** (the last display by default; `--display-index N` picks another) and fullscreens it. It then **prints a placement-verification prompt** and waits: press **Enter** to confirm the glass is on the show display, **`p`** to re-place it (display IDs reorder on reconnect — this is the re-place path the RFC demands), **`p N`** to re-place on display N, or **`q`** to stand the rig down.
5. **OBS is yours** — the orchestrator hands OBS to you (arm the capture + record; do the video meter-bounce). `Ctrl-C` (SIGINT) tears the whole rig down: children killed, `caffeinate` released.

Flags: `--plan <logId>` loads a planned set so the bridge can fingerprint its tracklist; `--one-mac` the fallback topology; `--display-index N` the show display; `--audio-index N` the avfoundation input to meter; `--check-only` runs pre-flight and launches nothing; `--no-browser` raises the servers without Chromium; `--force` departs past a holding check. `--help` prints them all.

## The pre-show checklist (every set — ordered, catastrophic-first)

`run show` automates the four checks marked **[auto]**; the rest are hands-and-eyes, in this order (RFC §5). Do not reorder — the earliest items are the ones that silently ruin a whole set.

1. **Both laptops on mains.** A set outlasts a battery, and low-power mode throttles the encoder and the render.
2. **Disk headroom on both machines** — ~40 GB free on the M5 for the `.mov`, room for the REC WAV on the M2. **[auto: the M5 side]**
3. **FLX4 into the M2**, Rekordbox's audio device = **DDJ-FLX4** (never an Aggregate Device — it kills the controller cue and starves any capture), **48 kHz**. The master leaves the FLX4's physical MASTER OUT as analog into the M-Track; no BlackHole / PC MASTER OUT is needed on the M2 in the two-machine rig (that is the one-Mac software path — see the recording doc for the Aggregate trap if you ever run it). **[auto: 48 kHz where readable]**
4. **Transport up, the M5 music meter bounces** — play a track; the M-Track input meter (and OBS's Audio Input Capture meter) must move. A flat meter is a dead route. **[auto: the RMS meter-bounce]**
5. **Mic present on the M5, Track 2 clean** — the mic reads on Mic/Aux, and Track 2 sits near-silent when you are not talking (music is monitor/headphone-only, so any music on Track 2 is acoustic leakage — gate it).
6. **OBS captures real pixels** — the **video meter-bounce**, per scene: flip through every scene in the collection and confirm each source shows actual moving pixels — the overhead camera framing the Arzopa + FLX4, and, if the glass cut-to scene exists, its Display Capture showing the glass moving, not a black rectangle. macOS screen-recording permission resets after an update and captures black silently (the video analogue of a dead audio route); re-grant it after any update. The glass must be fullscreen on the show display.
7. **DND / Focus on, notifications + display sleep off, update nags suppressed** — nothing may draw over the fullscreen glass or sleep the display mid-set.
8. **Channels reading, flash limiter armed, watchdog answering, context-loss smoke passed, permissions confirmed** — the glass's rails are live (the flash limiter armed, the watchdog heartbeat answering), the `WEBGL_lose_context` smoke recovers to the holding scene, and no permission dialog is hiding behind the fullscreen window.
9. **AV-sync profile loaded** — the calibrated audio-to-visual offset for this rig (the four-on-the-floor calibration recipe in the RFC).
10. **30-second Twitch test stream, zero dropped frames** — a real short stream, watched for drops, before the set.
11. **VideoToolbox + CBR confirmed** — the recording encoder is the dedicated hardware encoder at CBR (recording doc), not the stream encoder.
12. **Rekordbox REC armed** on the M2 — the belt-and-braces WAV master, zero routing in its path.
13. **Cameras live** — the overhead Continuity iPhone (and any second camera) is up and framed.

## The dress rehearsal protocol (acceptance, not vibes)

Run this once before the first real show, and again after any change to the rig (RFC §5). It is the acceptance gate — a show is not cleared to go live on a rig that has not passed it.

- **Full-duration thermal soak** on both machines — 90+ minutes, frame rate and master-audio dropouts logged to the very end. M2 contention (Rekordbox + the FLX4) and M5 contention (glass + OBS + camera) are only real once they have run hot for the length of a set.
- **Every failure injected live, while actually DJing** — pull the M-Track USB (audio gone), kill Chromium and time the on-air gap to the OBS fallback card and the watchdog relaunch, yank the camera, deliberately trip the flash and red limiters, and the combined single-cable fault (in v2, audio + OSC on one cable). Each must terminate gracefully at the holding scene / last-known state, never a crash or a white-out.
- **Produce and verify the deliverables from the rehearsal recording** — `ffprobe` the 3-track model, confirm Track 1 is clean music with no AGC contamination (the glass forces `echoCancellation`/`noiseSuppression`/`autoGainControl` off, but verify OBS's copy too), check AV-sync in the file, and run PEAT over the **composited** output (camera cuts create flashes the bare render never shows).
- **A permission / update drift dry-run** — simulate the post-update state (revoke and re-grant screen recording + microphone) and confirm the checklist catches it.
- **A true cold-boot timing of `run show`** — from both machines asleep to the glass fullscreen and the first meter-bounce, timed, so you know how long the rig takes to raise.

## Keys and remote cheat sheet

**`run show` (the terminal on the M5):**

| Key      | Does                                                                 |
| -------- | -------------------------------------------------------------------- |
| Enter    | confirm the glass is on the show display                             |
| `p`      | re-place the glass on the current display (IDs reorder on reconnect) |
| `p N`    | re-place on display N                                                |
| `q`      | stand the rig down (kills children, releases `caffeinate`)           |
| `Ctrl-C` | same as `q` — full teardown                                          |

**The glass (the show window):** the keyboard control surface is the glass's own (scene keys, the finding-cue, the guarded hold-to-engage blackout that eases into the holding scene, intensity, render-scale `r`, the HUD) — see the RFC §3 and the glass's own reference. The phone web-remote (served by the bridge at `http://<lan-ip>:4180/remote`) is the second-tier control for the two-machine rig; it earns its place after a rehearsal shows the reach across the room is needed.

## The one-Mac fallback

`run show --one-mac` runs the whole rig on a single machine (the M2): Rekordbox + FLX4 + the glass + the bridge + OBS all together. Two audio paths are available and it is config, not code, that decides:

- **The M-Track path (preferred):** the same inline splitter, USB into the M2 instead of the M5. Rekordbox owns the FLX4 (cue + the analog master out), the M-Track captures that master and presents it to OBS + Chrome on the same machine. The chain is identical to the two-machine rig minus one laptop.
- **The BlackHole software path:** the recording doc's "PC MASTER OUT → BlackHole 2ch" trick, with the glass reading BlackHole via `getUserMedia`. Use it only if the M-Track is unavailable; it puts the whole rig's contention on one machine and one audio device, so the thermal soak matters more.

Either way, the pre-show checklist and the dress rehearsal are unchanged; only the audio device names differ.

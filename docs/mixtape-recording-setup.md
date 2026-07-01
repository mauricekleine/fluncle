# Mixtape recording setup — Rekordbox + DDJ-FLX4 + OBS + BlackHole (macOS)

Your pre-flight checklist before hitting the decks: how to wire the audio/video rig for recording a Fluncle mixtape — DJ in Rekordbox on a Pioneer DDJ-FLX4, stream to Twitch and record in OBS, and come out with a clean stereo master for Mixcloud and a video for YouTube. It's hardware/app configuration, not code, but it's load-bearing for every mixtape, so it lives here. (Once you've got the recording, the `fluncle-mixtapes` skill takes it from there.)

## The one rule that matters

**PC MASTER OUT good. Aggregate Device bad.**

Rekordbox sends its master to one place. The trap is thinking you must choose between the FLX4 (so you can hear it) and BlackHole (so OBS can capture it). You don't: Rekordbox's **PC MASTER OUT** feature duplicates the master to your DJ gear _and_ the computer's audio at the same time. A macOS **Aggregate Device** is the wrong tool — it breaks the FLX4's headphone cue and starves BlackHole. (On 2026-06-28 an Aggregate Device silently replaced PC MASTER OUT and a whole 48-minute set recorded as a mono room-mic, because BlackHole got nothing and only the laptop mic caught the speakers.)

## Signal flow (what "wired correctly" looks like)

```
Rekordbox (master)
  ├─ DDJ-FLX4 ──► monitor speakers + headphone cue   (you hear + cue, FLX4-controlled)
  └─ BlackHole 2ch ──► OBS Audio Input Capture ──► Tracks 1 + 3
a mic ──► OBS Mic/Aux ──► Tracks 2 + 3
   ⇒ Track 1 = clean music (master)   Track 2 = clean mic   Track 3 = music + mic (Twitch)
```

## Setup (one-time)

### 1. BlackHole

Install BlackHole 2ch (`brew install blackhole-2ch`, reboot if it was a fresh install). Do **not** build an Aggregate or Multi-Output Device for this — they fight the FLX4.

### 2. Rekordbox → Preferences → Audio

- **Audio device = `DDJ-FLX4`** (not BlackHole, not an aggregate).
- Tick **"Output audio from the computer's built-in speakers and your DJ equipment (PC MASTER OUT)."**
- **Master Output** → select the combined **`DDJ-FLX4 + BlackHole 2ch`** option that appears once PC MASTER OUT is on. This is the whole trick: master now reaches the FLX4 (speakers + cue) _and_ BlackHole (OBS) simultaneously.
- **Headphones/Cue** → DDJ-FLX4 (so cueing works on the controller).

### 3. Rekordbox → Preferences → Analysis (DnB tempo accuracy)

- **BPM Range → `98–195`** so 172–176 DnB isn't analyzed at half speed (86). The setting only affects _future_ analysis; re-analyze existing tracks (right-click → Analyze Track, overwrite) to fix them. Per-track quick fix: the **2×** button in the grid editor.
- **Beat Grid → Normal/Static**, not Dynamic. DnB is fixed-tempo; a Dynamic grid makes the BPM readout drift through the track. Re-analyze after changing.

### 4. OBS

- **Audio Input Capture** source → Device = **`BlackHole 2ch`**. This is the music.
- **Mic/Aux** → your mic (Samson Q2U via the Scarlett, or whatever) — only if you talk on stream.
- **Track split — the clean 3-track model** (OBS → Advanced Audio Properties → Tracks). Each source gets its own track, plus a shared track for the stream:
  - Audio Input Capture (music / BlackHole) → **Tracks 1 + 3**
  - Mic/Aux → **Tracks 2 + 3**
  - Result: **Track 1 = clean music, Track 2 = clean mic, Track 3 = music + mic.** Track 1 is the master (Mixcloud + clips); Track 3 is the mixed live feed so Twitch chat hears you over the set.
- **Keep the mic track clean:** you monitor the music (headphones, or speakers), so an open mic bleeds it into Track 2. Keep monitoring volume sensible (closed-back cans help) or add a **noise gate** on Mic/Aux — Track 2 should sit near-silent when you're not talking. The music here is headphones-only, so _any_ music on Track 2 is acoustic leakage, not routing.
- **Output → Recording → Audio Tracks = `1` and `2`** (records clean music + clean mic, separate). Track 1 is the file's **default** audio, so the set video / clip cut / Mixcloud upload get clean music with no `-map` needed.
- **Output → Streaming → Audio Track = `3`** (Twitch live = music + your voice).
- **Output → Streaming → Twitch VOD Track = `2`** (mic-only) — the live stream stays full via Track 3, but the saved VOD uses the voice-only track so Twitch won't copyright-mute the archive. Optional (the VOD then has your voice but no music); skip it to just accept the odd muted section.
- Output → Audio → **Audio Bitrate 320** on the recorded tracks (Twitch max, worth it for music).
- **Video — Output (Scaled) Resolution = `1920×1080`** (Settings → Video), and Base (Canvas) `1920×1080` too (60 fps + Bicubic fine), both cameras sourced at 1080p. If this is left at `1280×720` the whole set bakes to 720p no matter how sharp the cameras are, and the 9:16 clips come out soft (Mixtape #1's bug).
- **Recording master encoder** (Output → Recording → Video Encoder): set a **dedicated `Apple VT H264 Hardware Encoder`** — do **not** leave "(Use stream encoder)", which caps the master at the ~6000 kbps Twitch bitrate. Then **Rate Control = `CBR`, Bitrate = `40000`** (40 Mbps ≈ 18 GB/hr): a pristine 1080p60 master that survives the downstream re-encodes, at near-zero CPU (hardware media engine) while you stream + DJ.
  - **NOT ProRes** — a 60-min set is 100–200 GB and would break the R2 → box → clip-cut pipeline + iCloud.
  - **NOT HEVC / AV1** — H.264 keeps browser `set.mp4` playback + the ffmpeg clip-cut + Cloudflare Media Transformations happy (AV1 is greyed out for Hybrid MOV anyway).
  - **CRF gotcha:** on Apple VT the CRF **"Quality" slider is higher = better** (0–100), the opposite of x264's lower-is-better CRF — a low number is _low_ quality. Use `CBR` + a bitrate (foolproof); if you insist on CRF, drag Quality to ~80–90.
- Output → Recording → Recording Format `.mov` (Hybrid MOV) or `.mp4`. Audio Encoder CoreAudio AAC.
- Keep the **same sample rate end to end** — OBS is at 48 kHz, so set BlackHole (Audio MIDI Setup) and Rekordbox to 48 kHz too, to avoid resample crackle/drift.

## Pre-flight (every single set — 10 seconds, non-negotiable)

1. Play a track in Rekordbox.
2. Watch the **OBS "Audio Input Capture" meter bounce.** Flat meter = dead route → fix before you play. Never record on faith; this one glance would have caught the 2026-06-28 silent-BlackHole set.
3. Confirm you hear **master on the speakers + cue in the headphones** through the FLX4.
4. **Belt-and-braces:** also hit Rekordbox's **REC** button (Preferences → Recordings sets the folder). It records the master straight to a clean stereo WAV with zero routing in the path — your guaranteed master if OBS misbehaves.

## After the set (produce the deliverables)

Probe the recording first to see the streams/tracks:

```bash
ffprobe -v error -show_entries 'format=duration:stream=index,codec_type,codec_name,channels' \
  -of default=noprint_wrappers=1 "<recording>.mov"
```

The **clean music track is Track 1** (`-map 0:a:0`, the file's default audio); Track 2 carries your isolated mic. Then:

```bash
# VIDEO for YouTube — remux video + the clean music track, no re-encode (fast, lossless)
ffmpeg -i "<recording>.mov" -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart out.mp4

# AUDIO master for Mixcloud — clean music track → 320k mp3
ffmpeg -i "<recording>.mov" -map 0:a:0 -c:a libmp3lame -b:a 320k out.mp3

# Trim dead air off the front (e.g. start at 4:30): add -ss 270 before -i
ffmpeg -ss 270 -i "<recording>.mov" -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart out.mp4
```

`-map 0:a:0` selects the **first** audio track — the clean, music-only one (Track 1, the default). Swap to `-map 0:a:1` (Track 2) only if you want the isolated mic. Then hand `out.mp4` + `out.mp3` to `fluncle admin mixtapes distribute`.

## Troubleshooting

| Symptom                                                                              | Cause                                                                                                                        | Fix                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OBS records **silence** on the BlackHole track; only the mic has sound (mono, roomy) | Rekordbox master is going to the FLX4 but **not** BlackHole — usually because an **Aggregate Device** replaced PC MASTER OUT | Delete the Aggregate Device. Rekordbox device = DDJ-FLX4, tick **PC MASTER OUT**, Master Output = `DDJ-FLX4 + BlackHole 2ch`. Verify the OBS meter bounces. |
| No **headphone cue** on the FLX4                                                     | Rekordbox is pointed at BlackHole alone, or at an Aggregate Device (aggregates kill controller cue)                          | Rekordbox device = DDJ-FLX4 (+ PC MASTER OUT). Cue lives on the FLX4 only when Rekordbox owns the FLX4 directly.                                            |
| Your **voice is in the Mixcloud mix**                                                | You extracted the mic (Track 2) instead of the music                                                                         | Extract **Track 1** (`-map 0:a:0`, the default/music); Track 2 is the isolated mic. Split = music → Tracks 1+3, mic → Tracks 2+3.                           |
| **Music bleeds onto the mic track** (Track 2 not clean when silent)                  | The mic is acoustically picking up the music from your headphones/monitors                                                   | Turn monitoring volume down / closed-back cans / add a noise gate on Mic/Aux. Music is headphones-only, so any music on Track 2 is leakage, not routing.    |
| DnB track shows **half BPM** (86 vs 172)                                             | Analysis BPM range tops out below 172                                                                                        | Preferences → Analysis → BPM Range `98–195`, then **re-analyze**. Quick: the **2×** button.                                                                 |
| **Tempo drifts/shifts** through a track                                              | Track analyzed with a **Dynamic** beatgrid                                                                                   | Preferences → Analysis → Beat Grid = Normal/Static, re-analyze. (If the tempo _fader_ jumps on load, that's **SYNC** — turn it off.)                        |
| Crackle / pitch drift in the recording                                               | Sample-rate mismatch                                                                                                         | Match the rate everywhere — OBS is 48 kHz, so set BlackHole (Audio MIDI Setup) + Rekordbox to 48 kHz.                                                       |

## References

- [AlphaTheta — stream OBS with DDJ-FLX4 + rekordbox (PC MASTER OUT)](https://support.alphatheta.com/en-US/articles/26128206440601?product=9366984218137)
- [We Are Crossfader — stream from Rekordbox with BlackHole](https://wearecrossfader.co.uk/blog/stream-from-rekordbox-with-no-soundcard/)
- [Lexicon — Rekordbox beatgrid analysis: static vs dynamic](https://www.lexicondj.com/blog/understanding-rekordbox-beatgrid-analysis)

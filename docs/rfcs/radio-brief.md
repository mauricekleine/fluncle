Fluncle Observations + Radio Brief

Goal

Add an audio observation layer to Fluncle.

Each track should eventually have:

metadata
BPM/key enrichment
context note
video bundle
audio observation

The audio observation is not a “radio host” segment. It is a recovered Fluncle field observation: what Fluncle saw/felt as he approached the star/coordinate, shaped by the track metadata, visual output, vibe tags, and any safe contextual findings about the song.

The radio page will later cycle through random tracks that have both video and audio.

⸻

Step 1 — Enrichment, video context, and audio generation

1. Add a track context enrichment step

Extend the existing enrichment flow that currently adds BPM/key.

New enrichment should:

- Run a firecrawl web search for the song.
- Search using artist, title, release/album, label, and year where available.
- Optionally include lyrics as context if available, but do not quote lyrics in generated output.
- Produce a short context note about the track.
- Store this note in the existing unused note field in the database.

The note should be concise and factual/useful, not prose-heavy.

Example note style:

Dark, driving liquid/neuro-leaning drum & bass track from [release/label/year]. Title and available context suggest cold seasonal imagery and stillness/motion contrast. Use as creative fuel only; do not quote lyrics.

Requirements:

- Do not invent facts.
- Store source URLs or raw search findings separately if the schema already supports it; otherwise keep the note conservative.
- The note is creative context for downstream agents, not public-facing copy by default.
- Lyrics may shape theme only at a high level. Do not quote or closely paraphrase lyrics.

2. Extend video generation to use note

Update the Fluncle video rendering agent so the generated props/context include the track note.

The video agent should use the note as additional creative fuel alongside:

artist
title
release/album
label
year
BPM
key
vibes: light/dark, floaty/driving
artwork palette
audio energy curve
existing enrichment data

The note should help influence:

vehicle choice
palette direction
motion language
texture family
visual metaphor

The video agent should still follow the Fluncle video doctrine:

- one phenomenon / one log entry
- recovered-footage feel
- organic, fluid, alive, alien
- no generic visualizer
- no literal “music video” interpretation
- no invented facts rendered as text

3. Add audio observation generation agent

Create a separate agent/process for generating per-track audio observations.

This agent should run independently, similar to the video agent.

Selection logic:

- Look at the track queue.
- Pick the oldest track that has:
  - enrichment complete
  - note present
  - video generated / video bundle available
  - no audio observation yet

The audio agent should gather:

track metadata
note
vibe tags
BPM/key
video bundle metadata
poster image URL
footage URL
composition/render metadata if available
visual summary if available

If no visual summary exists yet, derive a short one from available video metadata or the poster.

4. Generate an observation script

The script should be one voice only: Fluncle.

No host dialogue. No second character. No “radio show” framing.

The script should feel like:

Fluncle approaching a star/coordinate
observing the phenomenon
logging the experience
connecting it to the track

Structure:

1. Sensory observation of the phenomenon
2. Mood/energy description
3. Connection to the track/vibe
4. Log ID confirmation
5. Artist/title reveal

Example style:

The object first appeared as a sheet of blue pressure, folding over itself like glass under water.
As I moved closer, the surface pulled into long black veins. Not hostile. Just heavy. Driving. The signal carried a clean 174 pulse, cold at the edges, with a metallic lift through the centre.
I logged it as fluncle://004.1.9E.
System — Matrix and Futurebound Remix.

Rules:

- 20–45 seconds target duration.
- One voice.
- Observational, emotional, sparse.
- No hype voice.
- No fake DJ/radio phrases.
- Do not say “coming up next,” “what a tune,” “massive banger,” or similar.
- Do not quote lyrics.
- Do not invent factual claims.
- Mention the log ID.
- Mention artist and title.
- Optional: mention BPM/key/vibe only if it fits naturally.

Store the generated script as:

found.fluncle.com/<log-id>/observation.txt
found.fluncle.com/<log-id>/observation.json

Suggested JSON shape:

type ObservationScript = {
trackId: string;
fluncleUri: string;
text: string;
durationTargetSec: number;
inputs: {
usedNote: boolean;
usedVisualSummary: boolean;
usedLyricsContext: boolean;
};
};

5. Render audio with ElevenLabs

Use ElevenLabs for the first custom/polished version.

The agent should:

- Send the observation script to ElevenLabs.
- Use the configured Fluncle voice ID.
- Render one audio file per track.
- Normalize/prepare output if needed.
- Upload final audio to Cloudflare R2.

Output path:

found.fluncle.com/<log-id>/observation.mp3

Also upload render metadata:

found.fluncle.com/<log-id>/observation-render.json

Suggested render metadata:

type ObservationRender = {
trackId: string;
provider: "elevenlabs";
voiceId: string;
audioUrl: string;
textUrl: string;
durationMs?: number;
generatedAt: string;
};

6. Update database/API

After upload, mark the track as having an audio observation.

Add or expose fields similar to:

type TrackObservation = {
observationTextUrl?: string;
observationAudioUrl?: string;
observationDurationMs?: number;
observationGeneratedAt?: string;
};

The public track API should expose observation URLs where available.

⸻

Step 2 — radio.fluncle.com

Once tracks have both video and audio observations, build radio.fluncle.com.

Goal

A super lightweight continuous radio page that cycles through random bangers.

This is not full music streaming. It is a continuous stream of Fluncle observations and generated visuals.

The page should:

- Call existing /api/v1/random.
- Require/select tracks that have:
  - video URL
  - observation audio URL
  - basic metadata
- Play the observation audio.
- Display the matching generated video.
- Show basic track metadata.
- Move automatically to another random track when the segment ends.

Radio playback flow

For each cycle:

1. Fetch random track
2. Ensure track has observation audio and video
3. Load video
4. Load observation audio
5. Display metadata
6. Play segment
7. On end, fetch next random track
8. Repeat forever

Metadata to display

Minimum:

fluncle:// ID
artist
title
release/album
label/year if available
BPM
key
vibes
link to canonical log page
Spotify link if available

Visuals

Use existing generated video assets.

Current assets are portrait:

https://found.fluncle.com/<log-id>/poster.jpg
https://found.fluncle.com/<log-id>/footage-silent.mp4

For MVP:

- Use existing portrait footage.
- Center/crop/fit in the radio layout.
- Keep the page lightweight.
- Do not block on landscape renders.

Later:

- Add landscape video generation.
- Prefer landscape for full-screen radio mode.

Future landscape path:

https://found.fluncle.com/<log-id>/footage-silent-landscape.mp4

Radio page requirements

- Minimal UI.
- Autoplay where browser rules allow; otherwise show “Start transmission” button.
- Continuous playback.
- Smooth transition between tracks.
- Error handling: skip tracks with missing/broken assets.
- No commercial track audio.
- Observation audio only.
- Links to play/open the actual track externally.

Suggested endpoints

Existing:

GET /api/v1/random

Potential addition:

GET /api/v1/random?hasObservation=true&hasVideo=true

or:

GET /api/v1/radio/random

Suggested response includes:

type RadioTrack = {
id: string;
uri: string;
artist: string;
title: string;
bpm?: number;
key?: string;
vibes?: {
energy?: "light" | "dark";
motion?: "floaty" | "driving";
};
urls: {
log: string;
spotify?: string;
poster?: string;
video?: string;
observationAudio?: string;
observationText?: string;
};
};

Non-goals

Do not build yet:

full 24/7 stream server
Icecast/HLS livestream
commercial music streaming
live Rekordbox integration
real-time reactive visuals
live TTS generation per listener
multi-voice dialogue
account system
likes/comments/chat

Acceptance criteria

Step 1:

- Enrichment writes a useful context note to the existing note field.
- Video agent receives and uses note.
- Audio agent finds oldest eligible track without audio.
- Audio agent generates one-voice Fluncle observation script.
- ElevenLabs renders observation audio.
- Audio and metadata are uploaded to R2.
- Track API exposes observation audio URL.

Step 2:

- radio.fluncle.com loads.
- It fetches a random eligible track.
- It plays the track’s generated video and observation audio.
- It displays metadata and links.
- It automatically cycles to the next random eligible track.
- It skips broken/missing assets.
- It does not stream copyrighted track audio.

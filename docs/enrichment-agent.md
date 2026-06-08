# Enrichment Agent Bootstrap

Fluncle is Maurice's drum & bass publishing brand. The enrichment agent is the **async half of the track lifecycle**: the fast metadata add already happened (the track is live and listenable), and the agent fills in the analysis a little later — **BPM, musical key, a spectral feature vector, and a best-guess sub-genre** — and, when the kit is present, the per-track video. The agent does not exist as a runtime yet; this doc is the bootstrap that points it at its real instructions.

It is meant to run **anywhere**: locally on Maurice's machine, or as a Cloud Agent on a Spinup microVM. Its input is always one Fluncle **track id** or **log_id**, and nothing else.

## What it needs

- `bun` (runs the analysis script) and `ffmpeg` (decodes the preview);
- the `fluncle` CLI installed and, for the write step, authenticated (`FLUNCLE_API_TOKEN`); reads are public;
- network access (Deezer/iTunes for the preview; the Fluncle API).

It does **not** need a checkout of this repo. The enrichment skill is self-contained.

## Its constitution

**The full operating instructions are the `fluncle-track-enrichment` skill, not this doc.** Read it and follow it step by step:

- `packages/skills/fluncle-track-enrichment/SKILL.md` — the get → analyze → update loop, the rules (key honesty, never invent data, manual tags always win), and its self-contained `scripts/analyze-track.ts`.
- Install standalone (e.g. on Spinup): `npx skills add https://github.com/mauricekleine/fluncle/tree/main/packages/skills/fluncle-track-enrichment`. The analysis script has zero npm dependencies and no Fluncle imports, so it runs wherever the skill is installed.
- `docs/track-lifecycle.md` is the canonical architecture (sync add vs async enrich, the Worker/ffmpeg constraint, the feature vector, R2 ownership).

## Video render (separate, requires the kit)

Rendering the per-track video is a **separate capability** — Remotion needs the `packages/video` kit present (a repo checkout / prebuilt image), which the self-contained enrichment skill deliberately does not carry. Its doctrine lives in the **`fluncle-video` skill** (`packages/skills/fluncle-video/SKILL.md` + `references/`); `packages/video/README.md` is the code-of-record for the surface and props contract. When the kit is available, render + upload the MP4 via the admin video endpoint (the Worker owns R2; the agent never holds R2 credentials), then `fluncle admin track update <trackId> --video-url <url>`.

## Safety rails (inline so they survive even if the skill fails to load)

- One track per run.
- Preview audio comes only from the analysis script's resolver (Deezer/iTunes). Never source audio from YouTube or rip full tracks. No legal preview means no analysis; stop and report (`--status failed`).
- Never invent data. Write only what the audio yielded; respect the script's `null` key (atonal tracks key weakly — better null than wrong). The sub-genre is a **suggestion** stored as `auto`; a human `manual` tag overrides it and must never be clobbered.
- On-screen video copy passes VOICE.md; every on-screen fact comes from the track's props, which is authoritative. Render only fields the props expose; never invent one.
- The brand constants are not the agent's to restyle: if a concept fights the grammar, change the concept.
- Do not push or delete anything. The artifacts are the written-back metadata and (later) the MP4 + run report; the operator reviews and publishes.

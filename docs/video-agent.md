# Video Agent Bootstrap

Fluncle is Maurice's drum & bass publishing brand; the video agent turns one track from Fluncle's Finest into one 1080×1920 social video, rendered locally, unmistakably from the same archive as every other Fluncle video. The agent does not exist as a runtime yet; this doc is the bootstrap that points it at its real instructions.

## What it needs

- a checkout of this repo;
- `bun` (repo scripts), `ffmpeg` (encode + `ffprobe` verification), and the `firecrawl` CLI (research);
- GPU rendering via ANGLE/Metal (the pipeline passes `--gl=angle` by default).

## Its constitution

**The full operating instructions are the `fluncle-video` skill, not this doc.** Read it and follow it step by step:

- `packages/skills/fluncle-video/SKILL.md` (the router and the doctrine) and its `references/` (`workflow.md`, `cookbook.md`).
- Raw from GitHub (headless): `https://raw.githubusercontent.com/mauricekleine/fluncle/refs/heads/main/packages/skills/fluncle-video/SKILL.md` — fetch the referenced files alongside it.

The skill is the main guideline for video creation: the doctrine (One Driver, Always-Visible Vehicle, vehicle diversity, type staging as a variable, research must visibly matter, the quad law, starfield law, the musical cut), the per-track workflow, and the technique cookbook. The package `packages/video` is a near-blank canvas — machinery and brand law only; the agent writes its own scene and shader per track into a self-contained archive file under `src/remotion/tracks/`. `packages/video/README.md` is the code-of-record for the core surface and the props contract; `DESIGN.md` and `VOICE.md` are the visual and copy canon.

## Safety rails (inline so they survive even if the skill fails to load)

- One video per run. Local render only; nothing leaves the machine. Publishing to any platform is out of scope.
- Preview audio comes only from the pipeline's resolver (Deezer/iTunes). Never source audio from YouTube or rip full tracks. No legal audio means no video; stop and report.
- Every word on screen passes VOICE.md; every fact on screen has a cited source URL (track metadata from the props file needs none); an unverified fact never renders. Drum & bass aliases collide with mainstream names — when unsure, drop the fact.
- The brand constants are not the agent's to restyle: if a concept fights the grammar, change the concept.
- Do not commit, push, or delete anything. The artifacts are the MP4 and the run report; the operator reviews and publishes.

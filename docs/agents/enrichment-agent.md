# Track Agent Bootstrap (enrich → video → publish)

Fluncle is Maurice's drum & bass publishing brand. The enrichment agent is the **async half of the track lifecycle**: the fast metadata add already happened (the track is live and listenable), and the agent fills in the rest a little later — first the analysis (**BPM, musical key, and a spectral feature vector**), then — when the video kit is present — the **per-track video**, and finally the **social draft**. The agent does not exist as a runtime yet; this doc is the bootstrap that points it at its real instructions.

These are three capabilities, each its own skill, run in order: **enrich → video → publish**. Today they run as distinct steps — the analysis is buildable on Spinup now and ships autonomously; video + publish run by hand (locally). The target is a **single Spinup agent that chains all three**, fired by `ctx.waitUntil` when a track is added (see [track-lifecycle.md](../track-lifecycle.md) for the three phases and [ROADMAP.md](../ROADMAP.md) for the capstone + what blocks it — the render-capable Spinup profile). Whatever runs it, the contract is the same: the agent reads/writes only through the authenticated **`fluncle` CLI** (a thin client over the admin API); the Worker owns every secret (R2, Postiz, Turso) and the agent holds only its admin token.

It is meant to run **anywhere**: locally on Maurice's machine, or as a Cloud Agent on a Spinup microVM. Its input is always one Fluncle **track id** or **log_id**, and nothing else.

## What it needs

- `bun` (runs the analysis script) and `ffmpeg` (decodes the preview);
- the `fluncle` CLI installed and, for the write step, authenticated (`FLUNCLE_API_TOKEN`); reads are public;
- network access (Deezer/iTunes for the preview; the Fluncle API).

It does **not** need a checkout of this repo. The enrichment skill is self-contained.

## Its constitution

**The full operating instructions are the `fluncle-track-enrichment` skill, not this doc.** Read it and follow it step by step:

- `packages/skills/fluncle-track-enrichment/SKILL.md` — the get → analyze → archive → update loop, the rules (key honesty, never invent data, and the operator owns vibe placement), and its self-contained `scripts/analyze-track.ts`.
- Install standalone (e.g. on Spinup): `npx skills add https://github.com/mauricekleine/fluncle/tree/main/packages/skills/fluncle-track-enrichment`. The analysis script has zero npm dependencies and no Fluncle imports, so it runs wherever the skill is installed.
- `docs/track-lifecycle.md` is the canonical architecture (sync add vs async enrich, the Worker/ffmpeg constraint, the feature vector, R2 ownership).

## Preview archive (private analysis only)

The enrichment script may export the exact official 30s preview used for the feature vector. Store that file with:

```
fluncle admin track preview-archive <track_id|log_id> --file <file> --source <source> --mime <mime>
```

This writes to an operator-only archive path in the existing R2 bucket and records internal `preview_archive_*` metadata. It is for private analysis/model training only: the archive key is not exposed through public DTOs, never appears in UI/RSS/sitemaps, and `/api/preview` never reads it. Public playback stays live-only through Deezer with iTunes fallback and `Cache-Control: no-store`. Never archive full songs. New enrichments archive the exact analyzed bytes; backlog backfill is best-effort and archives the freshly re-resolved official preview.

## Video render (separate, requires the kit)

Rendering the per-track video is a **separate capability** — Remotion needs the `packages/video` kit present (a repo checkout / prebuilt image), which the self-contained enrichment skill deliberately does not carry. Its doctrine lives in the **`fluncle-video` skill** (`packages/skills/fluncle-video/SKILL.md` + `references/`); `packages/video/README.md` is the code-of-record for the surface and props contract. The kit's ship step produces a bundle under `out/<log-id>/`: `footage.mp4` (the review cut, with audio), `footage-silent.mp4` (the audio-less cut for manual TikTok sound-attach), `poster.jpg`, and `note.txt` (the caption). Upload the whole bundle in one call:

```
fluncle admin track video <track_id|log_id> --dir out/<log-id>
```

The CLI uploads each artifact **directly to R2** via short-lived presigned PUT URLs the Worker signs (`POST .../video/uploads` → PUT each file to its R2 S3 URL → `POST .../video/finalize`), so the bytes never traverse the Worker and a large (crf-20, ~99MB/cut) bundle bypasses Cloudflare's ~100MB edge body limit. Each artifact lands at `<log-id>/<name>` on R2 (`found.fluncle.com`) and `video_url` is set to the review cut. **The Worker owns R2; the agent uploads with its admin token and never holds R2 credentials** — it only ever sees the expiring presigned URLs. Requires the track to have a Log ID (one identity everywhere). (Small bundles can still use the legacy single multipart `POST /api/admin/tracks/:id/video`.)

## Publish draft (separate, via Postiz)

Once the bundle is in R2, the track can go to social platforms — **as a draft, never auto-posted.** The official sound attaches only in-app, so the agent pushes the **audio-less** cut + the caption as a private (`SELF_ONLY`) draft and the operator adds the sound and publishes natively. Doctrine is the **`fluncle-publish` skill** (`packages/skills/fluncle-publish/SKILL.md`); the model is [track-lifecycle.md](../track-lifecycle.md) Phase 3 + the per-platform `social_posts` table. Drafts go through **Postiz** — one `POSTIZ_API_KEY` on the Worker, no per-platform OAuth:

```
fluncle admin track draft  <track_id|log_id> [--platform tiktok]                                  # → inbox draft
fluncle admin track social <track_id|log_id> [--platform tiktok]                                  # show status
fluncle admin track social <track_id|log_id> --platform tiktok --status published --url <url>     # record outcome
```

- `track draft` → `POST /api/admin/tracks/:id/social/:platform/draft`: the Worker uploads the silent cut to Postiz and creates a `content_posting_method: UPLOAD` + `SELF_ONLY` post, sent immediately, which lands in the TikTok app **Inbox** (the `tiktok.com/messages` notification — _not_ Create → Drafts). Returns the Postiz post id, recorded in `social_posts`.
- `track social` with no `--status` → `GET …/social` lists per-platform state; with `--status` → `PATCH …/social/:platform` records `scheduled` / `published` (+ the live URL) or `failed`.

The agent never holds the Postiz key — the Worker owns it, same pattern as R2.

## Audio observation (separate, after video)

Once a track has its enrichment and (for the spoken script's creative fuel) ideally its video, the agent can mint the **audio observation** — Fluncle's spoken field observation, rendered with ElevenLabs and stored beside the video bundle at `<log-id>/observation.{mp3,txt,json}`. The agent authors + voice-gates the script (it holds `copywriting-fluncle`); the Worker fetches the factual context, re-scans, renders, uploads, and writes back. One command:

```
fluncle admin track observe <track_id|log_id> --script-file observation.txt --duration-ms <probed>
```

Its full doctrine is **[observation-agent.md](./observation-agent.md)** (the two artifacts, the voice gate, the safety rails — facts only, no lyrics, no commercial track audio). `observe` is auto-allowed but spends a paid render per call, so de-dupe per Log ID. The Worker owns the firecrawl + ElevenLabs secrets; the agent holds only its admin token.

## Safety rails (inline so they survive even if the skill fails to load)

- One track per run.
- Preview audio comes only from the analysis script's resolver (Deezer/iTunes). Never source audio from YouTube or rip full tracks. No legal preview means no analysis; stop and report (`--status failed`).
- Archive only the exact official preview used for analysis, through the operator-only archive path. It is not public media and not a playback source.
- Never invent data. Write only what the audio yielded; respect the script's `null` key (atonal tracks key weakly — better null than wrong). The agent writes analysis, not vibe placement; the operator owns the map in the `/admin` board (the Tag cell).
- On-screen video copy passes VOICE.md; every on-screen fact comes from the track's props, which is authoritative. Render only fields the props expose; never invent one.
- The brand constants are not the agent's to restyle: if a concept fights the grammar, change the concept.
- The agent's outputs are the written-back metadata, the uploaded video bundle, a **private** social draft, and a run report — nothing public. **Never publish, never attach a sound, never delete.** `track draft` is `SELF_ONLY`/`UPLOAD` by construction; the operator reviews in-app, attaches the official sound, and presses publish — then a human records the outcome with `track social --status published --url …`.

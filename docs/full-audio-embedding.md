# Full-song audio for MuQ embeddings

Status: Decision pending (operator, morning of 2026-07-07). The embed cron is PAUSED until this resolves.

## The decision (ratified)

MuQ must embed the **full song**, not the ~30-second preview. The reason, in the operator's words: a preview often contains only the intro, and for liquid DnB that intro can be just a piano — no beat, no bass. MuQ is a timbral/textural model, so a piano-only intro produces an embedding that says "quiet piano," clustering findings by their intro-mood rather than by the actual tune. The full track carries the drops, the bass, the arc — the things that make two DnB tunes genuinely alike. Quality wins decisively.

This supersedes the shipped Phase-1 choice (preview via `/api/preview/<id>`), which was expedient (the relay already existed) but structurally blind to everything past the first 30 seconds.

## Why this is a policy call, not a code swap

There is no full-audio fetch helper in the codebase today. The only full-song path in the repo is the `fluncle-bpm-backfill` skill's `yt-dlp` procedure, which is explicitly marked **"local-only, never on the microVM"** and downloads copyrighted audio as a guarded, transient, delete-after fallback (see that skill's §safety). The embed cron runs **on the box (rave-02, a microVM)** — so pointing it at the yt-dlp path would violate that stated posture. The `audio-source-policy` note sanctions "full audio = internal-analysis-only via an Apify downloader," but that downloader does not exist in code; it is a policy intent, not an implementation.

So full-song embedding requires a real decision about the copyright posture and where the download runs. That is the operator's call, not an agent's — which is why the cron is paused rather than half-wired overnight.

## The two mechanisms

**Option A — Apify (or a similar hosted actor), box-side.** The box calls a hosted scraping actor over HTTP, receives the full audio transiently, embeds it, discards it. Fits the `audio-source-policy` "internal-analysis-only" framing and keeps the pipeline autonomous on the box (the whole point of the cron). Costs: an Apify account + API token (a new secret in the Fluncle Automations vault), per-call cost, and the posture judgment that a hosted actor is an acceptable place for the transient copyrighted fetch. MuQ inference over a full ~5-minute track is minutes, not the preview's ~16s — so the cron's cap (3/tick) drops to 1/tick and the 300s `script_timeout_seconds` needs a look (a 5-minute track may exceed it; either raise the timeout or process one track across ticks).

**Option B — a local-only lane, feeding the box.** yt-dlp runs on the M5/M2 (where the bpm-backfill skill already sanctions it), embeds locally with the same MuQ venv, and writes the vector back via the agent-tier `update_track`. Keeps the copyrighted download strictly off the shared box, honoring the existing posture verbatim. Costs: it is no longer a hands-off box cron — it becomes an operator-run (or operator-machine-cron) job, so the "the box embeds every new finding on its own" model is lost; new findings wait for a local run.

## The cleanup either way

Three findings were embedded on previews during the Phase-1 proof (2fyMcl41…, 7tqoT2vU…, 44iDh0Jq…). When the full-song path lands, null their `embedding_json` so they re-queue (the queue is `embedding_json IS NULL`); the rest of the archive was never preview-embedded (the cron was paused after the proof tick).

## What we actually store in R2 today (checked)

Only the **preview** is archived: `preview-archive.ts` persists the ~30-second Deezer/iTunes clip to `n/previews/<logId>/<hash>.mp3` so it survives a stale source URL. There is **no full-song artifact** anywhere in the pipeline (every audio R2 key was searched). The `audio-source-policy` note's "full audio via an Apify downloader" was an intent that was never implemented — no Apify code exists.

## Option C — capture the full song once at add-time (the best shape)

Extend ingestion to fetch the full song once and store it in the same private analysis structure (e.g. `n/source/<logId>/…`), then the embed cron becomes a **pure box-side R2 read**: it downloads nothing, just pulls the stored full audio and embeds. This is cleaner than A or B — the copyrighted fetch happens once, at ingestion, wherever the operator decides is proper; the box stays fully autonomous with zero posture concern at embed-time; and the stored full audio is durable analysis fuel for anything future (better BPM, structure analysis, stems). It does NOT escape the core question — the download-and-store still happens somewhere at ingestion via some mechanism — but it pays it once per finding instead of per-embed, and confines the posture decision to one ingestion step.

## The one question for the operator (revised)

Not "which of A/B" but: **do we capture the full song once at add-time into private R2 (Option C), and by what mechanism** (a hosted actor, or a local ingestion lane)? On the answer, the build is: the ingestion fetch+store, a `source_audio_key` column, the embed-sweep source swap (R2 read), the cap/timeout adjustment for full-length inference, re-embed the 3 previews, resume the cron.

---
name: fluncle-publish
description: Publish a Fluncle track's video to social platforms as a reviewable DRAFT, and track per-platform publication status. Use when pushing a track's video to TikTok (or later YouTube Shorts / Instagram Reels) as a draft, recording that a draft/scheduled/published post exists, updating a post's status after manual review, or running the "publish" step of the track lifecycle. Drafts go via Postiz; the operator adds the official sound and publishes in-app.
---

# Fluncle social publishing

You take a track that already has a rendered video in R2 and push it to social platforms as a **private draft** for the operator to finish and publish by hand — then you track where it went and its state on each platform. You never auto-publish; publishing is a human action.

This is the **publish** step of the track lifecycle, after enrichment ([[fluncle-track-enrichment]]) and video creation (the `fluncle-video` skill, which renders + ships the bundle to R2). Per-platform state lives in `social_posts`; the generic track pipeline tops out at "video in R2" (`video_url`).

## Why drafts, not auto-posts

TikTok's licensed/official sounds can only be attached **inside the TikTok app**, not via any API. So the flow is built around the audio-less cut (`footage-silent.mp4`): we push it as a private draft, and the operator adds the official sound and publishes natively (better reach, too). The agent's job ends at "draft pushed"; the human takes it from there.

## Requirements

- The track has a **video in R2** (`video_url` set) and a **Log ID**. If not, render + ship it first (the `fluncle-video` skill); no video → nothing to publish.
- The **`fluncle` CLI**, authenticated for admin writes (`FLUNCLE_API_TOKEN`).
- The platform is connected in **Postiz** (the Worker holds `POSTIZ_API_KEY`; you never see it).

## Workflow

1. **Push the draft.**

   ```
   fluncle admin track draft <track_id|log_id> --platform tiktok
   ```

   This sends the track's **audio-less cut** to the platform as a private draft via Postiz. For TikTok it lands in the @fluncle app **inbox** as `SELF_ONLY`. Records `social_posts(platform, draft)`. Note: TikTok's inbox/upload flow accepts the **video file only** — the caption does _not_ transfer (the app shows a "#Postiz" placeholder). The caption is carried in the bundle's `note.txt` for the operator to paste in-app; this is inherent to the inbox flow, not a failure. (Only `DIRECT_POST` carries a caption, and it would skip the manual official-sound step — so we keep inbox.)

2. **Hand off to the operator (manual, human-only).** The operator opens the draft in the platform app, **pastes the caption** (from `note.txt`), **adds the official sound**, and publishes or schedules it. The agent does not and cannot do this step — it's where licensing + native posting happen. Stop here and report that the draft is waiting.

3. **Record the outcome** once the operator has acted:

   ```
   fluncle admin track social <track_id|log_id> --platform tiktok --status scheduled
   fluncle admin track social <track_id|log_id> --platform tiktok --status published --url <post-url>
   ```

   `published` requires the real `--url` (the inbox/draft API doesn't return the final post URL — the operator supplies it). `scheduled` can carry `--scheduled-for <iso>`.

4. **Inspect status** anytime:

   ```
   fluncle admin track social <track_id|log_id>
   ```

## Platforms

- **TikTok** — live, via Postiz (draft → inbox). The cut is audio-less; the operator adds the official sound in-app.
- **YouTube Shorts / Instagram Reels** — future. Same commands with `--platform`, once the channel is connected in Postiz. Whether a platform supports a true "draft" (vs. schedule/auto-publish) is per-platform; document each here as it's added.

## Rules

- **Drafts only.** You never auto-publish to a public platform. Publishing is the operator's in-app action.
- **Video first.** No `video_url` → refuse; render + ship it before publishing.
- **One post per (track, platform).** Re-running `draft` refreshes the existing draft, not a duplicate.
- **Never invent a published URL.** Only set `--url` to the real post URL after the operator has actually published.
- The caption is whatever `note.txt` holds (produced by the `fluncle-video` skill, in Fluncle's voice). You don't rewrite it here.

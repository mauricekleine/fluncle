---
name: fluncle-publish
description: Publish a Fluncle track's video to social platforms and track per-platform publication status. Use when pushing a track's video to TikTok (an inbox draft the operator finishes by hand) or YouTube Shorts (a direct public post on the push) — recording that a draft/published post exists, updating a post's status, or running the "publish" step of the track lifecycle. Pushes go via Postiz. Instagram is manual-only (no legitimate automated audio path), not part of the pipeline.
---

# Fluncle social publishing

You take a track that already has a rendered video in R2 and push it to social platforms, then track where it went and its state on each platform. **Nothing reaches a public feed without a human gate** — but how that gate works is per-platform.

This is the **publish** step of the track lifecycle, after enrichment ([[fluncle-track-enrichment]]) and video creation (the `fluncle-video` skill, which renders + ships the bundle to R2). Per-platform state lives in `social_posts`; the generic track pipeline tops out at "video in R2" (`video_url`).

## The per-platform rule: draft only when the API can't carry it

The manual inbox/draft hand-off exists for exactly one reason — to let a human supply what the platform's API can't. **TikTok** needs it: its licensed/official sounds attach **only inside the app**, and the inbox flow drops the caption, so we push the audio-less cut (`footage-silent.mp4`) and the operator adds the sound, cover, and caption by hand. **YouTube doesn't need it**: the API carries the title/description, a custom cover, and the video's own baked-in audio, so the push posts a Short directly. **Instagram is excluded** — see below.

| Platform                     | Cut pushed           | Caption          | Cover                          | Audio                                 | Flow                                                                                                  |
| ---------------------------- | -------------------- | ---------------- | ------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **TikTok** (live)            | `footage-silent.mp4` | ✗ inbox drops it | ✗ set in-app                   | ✗ licensed sound attaches only in-app | **Draft → manual finish** in the @fluncle app inbox (`SELF_ONLY`). Operator pastes caption, sets cover, adds the sound, publishes. |
| **YouTube Shorts** (live)    | `footage.mp4`        | ✓ title + description | ✓ custom thumbnail (`cover.jpg`) | ✓ the video's own audio               | **Direct public upload** (Data API v3) on the push — title/description/thumbnail carry. Content ID may *claim* the clip (rights holder monetizes, we don't) — accepted; the goal is reach. |
| **Instagram Reels** (not automated) | —          | —                | —                              | ✗ a baked-in master gets **muted/removed** on a business/creator account; the licensed library is app-only + locked for business | **Manual, in-app only.** No legitimate API audio path, so the pipeline doesn't post to Instagram. |

The takeaway: **draft is the TikTok exception; YouTube posts directly; Instagram isn't automated at all.** Don't add an Instagram push — re-uploading the master gets muted on our account type, and IG's licensed audio can't be attached via API (it's app-only, and locked for business accounts), so the only legitimate IG path is a hand-made post in the app. See `docs/track-lifecycle.md` (Phase 3) for the canonical version.

## Requirements

- The track has a **video in R2** (`video_url` set) and a **Log ID**. If not, render + ship it first (the `fluncle-video` skill); no video → nothing to publish.
- The **`fluncle` CLI**, authenticated for admin writes (`FLUNCLE_API_TOKEN`).
- The platform is connected in **Postiz** (the Worker holds `POSTIZ_API_KEY`; you never see it).

## Workflow — TikTok (live, manual finish)

1. **Push the draft.**

   ```
   fluncle admin track draft <track_id|log_id> --platform tiktok
   ```

   This sends the track's **audio-less cut** to the platform as a private draft via Postiz. For TikTok it lands in the @fluncle app **inbox** as `SELF_ONLY`. Records `social_posts(platform, draft)`. Note: TikTok's inbox/upload flow accepts the **video file only** — the caption does _not_ transfer (the app shows a "#Postiz" placeholder). The caption is carried in the bundle's `note.txt` for the operator to paste in-app; this is inherent to the inbox flow, not a failure. (Only `DIRECT_POST` carries a caption, and it would skip the manual official-sound step — so we keep inbox.)

   **Rate limit — max 5 inbox drafts per 24 hours (TikTok-side).** TikTok caps pending (unpublished inbox / `SELF_ONLY`) posts at **5 within any rolling 24-hour period**; the 6th is rejected ("TikTok limits pending posts to 5 within any 24-hour period"). The failure is **asynchronous**: `fluncle admin track draft` and Postiz both report success (Postiz mints a post id), but TikTok bounces the over-limit ones downstream — surfaced only as a Postiz error notification, never in the CLI output. So a batch of more than 5 cannot all be drafted the same day: push **≤ 5 per 24h**, space the rest across days, and re-push any that bounced after 24 hours. The count includes drafts still sitting unpublished in the inbox — the operator clearing the inbox (publishing/deleting) frees the budget.

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

## Workflow — YouTube (direct, live)

No inbox, no manual finish: the push **posts a public Short directly**. The endpoint sends the **with-audio cut** (`footage.mp4`) with the track title, the caption (`note.txt`) as the description, and the cover (`cover.jpg`) as the thumbnail, and records `social_posts(youtube, published)`.

```
fluncle admin track draft <track_id|log_id> --platform youtube     # uploads a public Short now
```

- **The push is the publish.** The operator's run/click is the only gate — there's no review stage, so push only when the video is final. Postiz doesn't return the public URL on create, so the row lands at `published` with no `url`; record the real link later with `… social … --platform youtube --url <url>`.
- **Content ID is expected.** A short clip with the master usually gets *claimed* (the rights holder monetizes it, we don't) rather than blocked — that's accepted; the goal is reach, not revenue. (`unlisted`/`private` is in the schema if a review gate is ever wanted — change `type` in `pushYouTubeShort`.)

## Instagram — manual, not in the pipeline

Don't push Instagram from the CLI/board. Baking the master into a Reel gets muted/removed on our business/creator account, and IG's licensed audio is app-only (and locked for business), so there's no legitimate automated path. Any Instagram presence is a hand-made post in the IG app.

## Platforms

- **TikTok** (`--platform tiktok`) — live. Draft → app inbox; audio-less cut; the operator adds the official sound in-app.
- **YouTube Shorts** (`--platform youtube`) — live. Direct public Short; track title + caption (description) + `cover.jpg` thumbnail carry.
- **Instagram Reels** — manual only (see above); no `--platform` slug.

## Rules

- **Never public without a human gate.** Only the TikTok push is safe for an agent to fire on its own — it lands in the private inbox (`SELF_ONLY`) and a human still finishes and publishes it in-app. **A YouTube push goes straight to a public feed**, so it's an operator action (the run/click is the approval), never an autonomous agent post.
- **Video first.** No `video_url` → refuse; render + ship it before publishing.
- **Right cut per platform.** TikTok gets `footage-silent.mp4` (sound added in-app); YouTube gets `footage.mp4` (its own audio plays).
- **One post per (track, platform).** Re-running the push refreshes the existing record, not a duplicate.
- **Never invent a published URL.** Only set `--url` to the real post URL after the post is actually public.
- The caption is whatever `note.txt` holds (produced by the `fluncle-video` skill, in Fluncle's voice). You don't rewrite it here.

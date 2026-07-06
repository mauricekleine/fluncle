---
name: fluncle-publish
description: Publish a Fluncle track's video to social platforms and track per-platform publication status. Use when pushing a track's video to TikTok (an inbox draft the operator finishes by hand) or YouTube Shorts (a direct public post on the push) — recording that a draft/published post exists, updating a post's status, or running the "publish" step of the track lifecycle. Pushes go via Postiz. For a FINDING, Instagram is manual-only (no legitimate automated audio path); automated IG posting exists only for set CLIPS (the clip drip-feed, in the fluncle-mixtapes skill).
---

# Fluncle social publishing

You take a track that already has a rendered video in R2 and push it to social platforms, then track where it went and its state on each platform. **Nothing reaches a public feed without a human gate** — but how that gate works is per-platform.

This is the **publish** step of the track lifecycle, after enrichment ([[fluncle-track-enrichment]]) and video creation (the `fluncle-video` skill, which renders + ships the bundle to R2). Per-platform state lives in `social_posts`; the generic track pipeline tops out at "video in R2" (`video_url`).

## The per-platform rule: draft only when the API can't carry it

The manual inbox/draft hand-off exists for exactly one reason — to let a human supply what the platform's API can't. **TikTok** needs it: its licensed/official sounds attach **only inside the app**, and the inbox flow drops the caption, so we push the portrait social cut **silenced** (`footage.social.mp4` served through an `audio=false` Media Transformation) and the operator adds the sound, cover, and caption by hand. **YouTube doesn't need it**: the API carries the title/description and the video's own baked-in audio, so the push posts a Short directly. **Instagram is excluded** — see below.

Both platforms push the same portrait master, `footage.social.mp4` (1080×1920, baked text) — TikTok gets it silenced on the fly via an `audio=false` MT, YouTube gets it with audio. There is **no stored silent file**: `footage-silent.mp4` is retired (a legacy finding without the two-master signal still falls back to `footage.mp4` / `footage-silent.mp4`). The clean SQUARE `footage.mp4` is only the crop source that the MTs derive other orientations from — it is never the cut pushed to a feed (see `docs/video-variants.md`).

| Platform                            | Cut pushed                              | Caption               | Cover                                              | Audio                                                                                                                            | Flow                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------- | --------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TikTok** (live)                   | `footage.social.mp4` (`audio=false` MT) | ✗ inbox drops it      | ✗ set in-app                                       | ✗ licensed sound attaches only in-app (the cut is silenced via the MT)                                                           | **Draft → manual finish** in the @fluncle app inbox (`SELF_ONLY`). Operator pastes caption, sets cover, adds the sound, publishes.                                               |
| **YouTube Shorts** (live)           | `footage.social.mp4`                    | ✓ title + description | ✗ no custom thumbnail (YouTube auto-picks a frame) | ✓ the video's own audio                                                                                                          | **Direct public upload** (Data API v3) on the push — title/description carry. Content ID may _claim_ the clip (rights holder monetizes, we don't) — accepted; the goal is reach. |
| **Instagram Reels** (not automated) | —                                       | —                     | —                                                  | ✗ a baked-in master gets **muted/removed** on a business/creator account; the licensed library is app-only + locked for business | **Manual, in-app only.** No legitimate API audio path, so the pipeline doesn't post to Instagram.                                                                                |

The takeaway: **draft is the TikTok exception; YouTube posts directly; Instagram isn't automated at all.** Don't add an Instagram push — re-uploading the master gets muted on our account type, and IG's licensed audio can't be attached via API (it's app-only, and locked for business accounts), so the only legitimate IG path is a hand-made post in the app. See `docs/track-lifecycle.md` (Phase 3) for the canonical version.

## Requirements

- The track has a **video in R2** (`video_url` set) and a **Log ID**. If not, render + ship it first (the `fluncle-video` skill); no video → nothing to publish.
- The **`fluncle` CLI**, authenticated for admin writes (`FLUNCLE_API_TOKEN`).
- The platform is connected in **Postiz** (the Worker holds `POSTIZ_API_KEY`; you never see it).

## Workflow — TikTok (live, manual finish)

1. **Push the draft.**

   ```
   fluncle admin tracks draft <track_id|log_id> --platform tiktok
   ```

   This sends the track's **silenced portrait cut** (`footage.social.mp4` through an `audio=false` MT) to the platform as a private draft via Postiz. For TikTok it lands in the @fluncle app **inbox** as `SELF_ONLY`. Records `social_posts(platform, draft)`. Note: TikTok's inbox/upload flow accepts the **video file only** — the caption does _not_ transfer (the app shows a "#Postiz" placeholder). The caption is carried in the bundle's `note.txt` for the operator to paste in-app; this is inherent to the inbox flow, not a failure. (Only `DIRECT_POST` carries a caption, and it would skip the manual official-sound step — so we keep inbox.)

   **Rate limit — max 5 inbox drafts per 24 hours (TikTok-side).** TikTok caps pending (unpublished inbox / `SELF_ONLY`) posts at **5 within any rolling 24-hour period**; the 6th is rejected ("TikTok limits pending posts to 5 within any 24-hour period"). The failure is **asynchronous**: `fluncle admin tracks draft` and Postiz both report success (Postiz mints a post id), but TikTok bounces the over-limit ones downstream — surfaced only as a Postiz error notification, never in the CLI output. So a batch of more than 5 cannot all be drafted the same day: push **≤ 5 per 24h**, space the rest across days, and re-push any that bounced after 24 hours. The count includes drafts still sitting unpublished in the inbox — the operator clearing the inbox (publishing/deleting) frees the budget.

2. **Hand off to the operator (manual, human-only).** The operator opens the draft in the platform app, **pastes the caption** (from `note.txt`), **adds the official sound**, and publishes or schedules it. The agent does not and cannot do this step — it's where licensing + native posting happen. Stop here and report that the draft is waiting.

3. **Record the outcome** once the operator has acted:

   ```
   fluncle admin tracks social <track_id|log_id> --platform tiktok --status scheduled
   fluncle admin tracks social <track_id|log_id> --platform tiktok --status published --url <post-url>
   ```

   `published` requires the real `--url` (the inbox/draft API doesn't return the final post URL — the operator supplies it). `scheduled` can carry `--scheduled-for <iso>`.

4. **Inspect status** anytime:

   ```
   fluncle admin tracks social <track_id|log_id>
   ```

## Workflow — YouTube (direct, live)

No inbox, no manual finish: the push **posts a public Short directly**. The endpoint sends the **with-audio portrait cut** (`footage.social.mp4`) with the track title and the caption (`note.txt`) as the description, and records `social_posts(youtube, published)`. No custom thumbnail is set (`thumbnail: null` in `pushYouTubeShort`) — YouTube auto-picks a frame, which reads better than the cover card.

```
fluncle admin tracks draft <track_id|log_id> --platform youtube     # uploads a public Short now
```

- **The push is the publish.** The operator's run/click is the only gate — there's no review stage, so push only when the video is final. Postiz doesn't return the public URL on create, so the row lands at `published` with no `url`; record the real link later with `… social … --platform youtube --url <url>`.
- **Content ID is expected.** A short clip with the master usually gets _claimed_ (the rights holder monetizes it, we don't) rather than blocked — that's accepted; the goal is reach, not revenue. (`unlisted`/`private` is in the schema if a review gate is ever wanted — change `type` in `pushYouTubeShort`.)

## Instagram — manual for FINDINGS; automated for set CLIPS

Don't push a **finding's** video to Instagram from the CLI/board. Baking a single copyrighted master into a Reel gets muted/removed on our business/creator account, and IG's licensed audio is app-only (and locked for business), so there's no legitimate automated path for a finding. Any Instagram presence for a finding is a hand-made post in the IG app.

**A set CLIP is the exception, and it IS automated** (the clip drip-feed — a separate object from a finding). A clip is cut from a live-mixed DJ _set_, which fingerprints differently from a single master, so its own audio survives on IG (the audio-survival spike passed). Clips auto-enter a jittered ~daily Instagram queue and drip out through Postiz as Reels; a global kill switch halts everything if a clip gets struck. That flow lives in the `fluncle-mixtapes` skill (clips are set-derived), not here. This skill stays finding-only: **no `--platform instagram` for a finding.**

## Platforms

- **TikTok** (`--platform tiktok`) — live. Draft → app inbox; the silenced portrait cut (`footage.social.mp4` via an `audio=false` MT); the operator adds the official sound in-app.
- **YouTube Shorts** (`--platform youtube`) — live. Direct public Short; track title + caption (description) carry; no custom thumbnail (YouTube auto-picks a frame).
- **Instagram Reels** — manual only (see above); no `--platform` slug.

## Rules

- **Never public without a human gate.** Only the TikTok push is safe for an agent to fire on its own — it lands in the private inbox (`SELF_ONLY`) and a human still finishes and publishes it in-app. **A YouTube push goes straight to a public feed**, so it's an operator action (the run/click is the approval), never an autonomous agent post.
- **Video first.** No `video_url` → refuse; render + ship it before publishing.
- **Right cut per platform.** Both push the portrait `footage.social.mp4`: TikTok gets it silenced via an `audio=false` MT (sound added in-app); YouTube gets it with its own audio. (`footage.mp4` is the clean square crop source, never a feed cut.)
- **One post per (track, platform).** Re-running the push refreshes the existing record, not a duplicate.
- **Never invent a published URL.** Only set `--url` to the real post URL after the post is actually public.
- The caption is whatever `note.txt` holds (produced by the `fluncle-video` skill, in Fluncle's voice). You don't rewrite it here.

# Fluncle TikTok Content Pipeline

## Overview

Fluncle is a drum & bass discovery platform.

The core premise is simple:

txt Maurice discovers bangers. Fluncle does everything else.

When a track is added to Fluncle, the system should automatically:

1. Resolve metadata.
2. Resolve a legal preview audio clip.
3. Analyze the audio.
4. Generate a beat-synchronized visual.
5. Render a TikTok-sized video.
6. Generate a caption.
7. Push a TikTok draft.
8. Track publication status.

The final step of attaching the official TikTok sound and publishing remains manual.

This keeps Fluncle aligned with TikTok's licensing ecosystem while still achieving near-complete automation.

---

# Goals

The goal is not to build a music redistribution system.

The goal is to build an autonomous content generation pipeline that turns music curation into social content.

Desired experience:

txt ssh rave.fluncle.com Add track Done.

Everything else happens automatically.

---

# Content Philosophy

Fluncle is a music discovery account.

Fluncle should:

- credit artists
- credit tracks
- promote discovery
- link listeners back to artists

Fluncle should not:

- re-upload full tracks
- rely on copyrighted audio redistribution
- attempt to bypass platform music licensing

---

# High-Level Flow

txt Spotify Track Added ↓ Metadata Resolution ↓ Preview Audio Resolution ↓ Audio Analysis ↓ Video Generation ↓ Caption Generation ↓ TikTok Draft Upload ↓ Manual Song Attachment ↓ Manual Publish ↓ Publication Verification

---

# Automatic Steps

These should run without human intervention.

## 1. Track Added

Trigger:

bash fluncle add <spotify-url>

or

bash fluncle admin add <spotify-url>

Store:

ts track { spotify_id isrc title artist album release_date artwork_url }

Enrich:

txt label source_tags caption_tags

Source tags are niche music-discovery tags gathered from trusted enrichment sources when available. They should help captions surface the track to the right scene, for example liquid funk, neurofunk, chill dnb, drum and bass, or label-specific tags.

---

## 2. Preview Audio Resolution

Goal:

Obtain a legal 15–30 second preview clip.

Resolution order:

txt Spotify preview_url ↓ Deezer preview via ISRC ↓ Apple/iTunes preview ↓ Fallback search

Store:

ts preview_audio { source url confidence }

Important:

The preview audio is used ONLY for analysis and local review.

It should never be uploaded to TikTok.

---

## 3. Audio Analysis

Analyze:

- BPM
- beat grid
- energy curve
- onset detection
- drop location
- recommended song offset

Output:

ts audio_analysis { bpm drop_ms beat_timestamps energy_curve confidence }

Example:

json { "bpm": 174, "drop_ms": 7200 }

---

## 4. Video Generation

Use Remotion.

Render:

txt 1080 x 1920 9:16 15–30 seconds

Style:

- kaleidoscope
- space-like
- grainy
- floaty
- procedural
- music-reactive

Video reacts to:

txt beat hits bass energy onsets phrase changes

---

## 5. Text Overlays

Include:

txt Artist Track Year

Optional:

txt Label Genre

Example:

txt Delta Heavy Ecstasy 2014

---

## 6. Caption Generation

Generate:

txt Artist Track Spotify link hashtags

Use enrichment tags when available.

Hashtags should combine:

- stable Fluncle defaults
- niche source tags
- label or artist tags when useful

Source tags are discovery fuel, not canonical facts. They should improve TikTok reach and scene relevance without inventing claims about the track.

Example:

txt Delta Heavy — Ecstasy One of this week's Fluncle selections. #dnb #drumandbass #fluncle

---

## 7. Public Marker Generation

Every post receives a unique public marker.

Example:

txt rave://7F3A

or

txt transmission FLN-7F3A

The marker serves two purposes:

### Human

Acts as a fun easter egg.

Followers may begin recognizing these markers.

### System

Allows publication reconciliation.

Example:

txt rave://7F3A

maps directly to:

txt social_post.id

---

## 8. TikTok Draft Upload

Fluncle should automatically upload the rendered video to TikTok.

Target:

TikTok Creator Inbox / Draft Flow.

Upload:

- video
- caption
- marker

DO NOT:

- attach music
- publish

Result:

txt Status: draft_pushed

---

# Manual Steps

These remain intentionally manual.

## 1. Open Draft

Open TikTok.

Navigate to Fluncle drafts.

---

## 2. Attach Official Song

Search:

txt artist track

Select official TikTok sound.

---

## 3. Align Song

Fluncle should provide:

txt Suggested Sound Start: 00:07.2

derived from audio analysis.

---

## 4. Publish

Publish manually.

This keeps all music licensing inside TikTok's ecosystem.

---

# Publication Verification

Publication should not rely on manual bookkeeping.

Instead:

txt Agent runs every hour

---

## Reconciliation Agent

Checks:

txt Recent TikTok posts

Matches:

txt public marker

Example:

txt rave://7F3A

If found:

ts social_post.status = "posted_verified" social_post.url = "..." social_post.posted_at = ...

---

# Status Lifecycle

txt queued ↓ preview_resolved ↓ analyzed ↓ rendering ↓ rendered ↓ draft_pushed ↓ awaiting_publish ↓ posted_verified

Optional:

txt needs_review stale_draft failed

---

# Required TikTok Setup

## TikTok Account

Account:

txt @fluncle

Requirements:

- Dedicated account
- Creator account recommended
- Consistent profile branding
- Profile link back to Fluncle

---

## TikTok Developer App

Create:

txt TikTok Developer App

Required for:

- OAuth
- Content Posting API
- Draft upload flow

Prepare:

txt Client ID Client Secret

Store in:

txt TIKTOK_CLIENT_ID TIKTOK_CLIENT_SECRET

---

## OAuth

Authorize:

txt @fluncle

Store:

txt Access Token Refresh Token

---

# Required Secrets

Spotify:

txt SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET

TikTok:

txt TIKTOK_CLIENT_ID TIKTOK_CLIENT_SECRET

Storage:

txt R2_BUCKET R2_ACCESS_KEY R2_SECRET_KEY

Optional:

txt DISCORD_WEBHOOK_URL

for notifications.

---

# Deliverables

## Assets

txt review.mp4 publish.mp4 caption.txt analysis.json

---

## Database

txt tracks preview_audio audio_analysis social_posts

---

## Future Extensions

Out of scope for V1:

- automatic publishing
- Instagram
- YouTube Shorts
- newsletters
- performance analytics
- view/engagement syncing

The only human action in V1 should be:

txt Choose song Attach official TikTok sound Press Publish

Everything else should happen automatically.

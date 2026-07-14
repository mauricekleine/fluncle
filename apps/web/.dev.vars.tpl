FLUNCLE_API_TOKEN=op://$FLUNCLE_1PASSWORD_ENV_ITEM/FLUNCLE_API_TOKEN
BETTER_AUTH_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/BETTER_AUTH_SECRET
BETTER_AUTH_URL=http://127.0.0.1:3000

# Admin allow-list for "Login with Spotify" (the operator identity). Comma-separated.
# ADMIN_ALLOWED_EMAILS is required; ADMIN_ALLOWED_SPOTIFY_IDS is optional (exact match).
ADMIN_ALLOWED_EMAILS=op://$FLUNCLE_1PASSWORD_ENV_ITEM/ADMIN_ALLOWED_EMAILS
ADMIN_ALLOWED_SPOTIFY_IDS=op://$FLUNCLE_1PASSWORD_ENV_ITEM/ADMIN_ALLOWED_SPOTIFY_IDS
ADMIN_SESSION_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/ADMIN_SESSION_SECRET

FIRECRAWL_API_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/FIRECRAWL_API_KEY

# Cartesia (Sonic) TTS for the audio-observation render — the only observation
# voice. Only the API key is a secret; CARTESIA_VOICE_ID is non-secret config in
# wrangler.jsonc vars (applied to local dev too), so it does not belong here.
CARTESIA_API_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/CARTESIA_API_KEY

POSTIZ_API_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/POSTIZ_API_KEY
POSTIZ_API_URL=

# Everyday local dev talks to a private libSQL server (turso dev) backed by
# apps/web/.dev/local.db. `bun run db:refresh-dev` seeds that db and rewrites
# these two lines to a local http://127.0.0.1:<port> URL with a dummy token.
# Leave them blank here; they are filled in locally. Real Turso credentials are
# never stored here -- production creds live in 1Password and are read by
# `bun run db:pull-prod` (the `Turso Production Credentials` item, Fluncle vault).
# See docs/local-database.md.
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

SPOTIFY_CLIENT_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/SPOTIFY_CLIENT_SECRET
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/api/admin/spotify/auth/callback
SPOTIFY_PLAYLIST_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/SPOTIFY_PLAYLIST_ID

# Mixtape distribution OAuth (mixtape autopublish). Client id/secret from 1Password;
# the redirect URIs are the LOCAL callbacks (register the matching 127.0.0.1:3000 URI
# in the Google OAuth client too — Google requires an exact match; Mixcloud takes the
# redirect at runtime so no registration needed).
YOUTUBE_CLIENT_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/YOUTUBE_CLIENT_SECRET
YOUTUBE_REDIRECT_URI=http://127.0.0.1:3000/api/admin/youtube/auth/callback
# A plain YouTube Data API v3 key (a `key=` query param, not OAuth) for the /reach
# collector's public channel stats. Optional — absent, the youtube leg skips cleanly.
# YOUTUBE_API_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/YOUTUBE_API_KEY
# GITHUB_TOKEN=op://$FLUNCLE_1PASSWORD_ENV_ITEM/GITHUB_TOKEN
# Mixcloud needs no redirect-URI var — it's derived from the request origin.
MIXCLOUD_CLIENT_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/MIXCLOUD_CLIENT_ID
MIXCLOUD_CLIENT_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/MIXCLOUD_CLIENT_SECRET

# /reach Tier-2 OAuth (docs/reach-tier2-activation.md) — one number apiece behind a
# per-platform user OAuth + refresh. All OPTIONAL: each leg is DORMANT until its creds
# are set AND the operator connects from /admin, so local dev works unprovisioned. The
# redirect URI is derived from the request origin (like Mixcloud) — register that exact
# 127.0.0.1:3000 (or prod) callback URL in each platform's app console. Uncomment + fill
# from 1Password to exercise a leg.
# TWITCH_CLIENT_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/TWITCH_CLIENT_ID
# TWITCH_CLIENT_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/TWITCH_CLIENT_SECRET
# INSTAGRAM_CLIENT_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/INSTAGRAM_CLIENT_ID
# INSTAGRAM_CLIENT_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/INSTAGRAM_CLIENT_SECRET

TELEGRAM_BOT_TOKEN=op://$FLUNCLE_1PASSWORD_ENV_ITEM/TELEGRAM_BOT_TOKEN
TELEGRAM_CHANNEL_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/TELEGRAM_CHANNEL_ID
DISCORD_WEBHOOK_URL=op://$FLUNCLE_1PASSWORD_ENV_ITEM/DISCORD_WEBHOOK_URL

# Bluesky (AT Protocol) publish side-channel: the handle/identifier + an APP
# PASSWORD (created in Bluesky settings, not the account password) for
# @fluncle.com (a leading "@" in the stored identifier is fine — bluesky.ts
# strips it). Both unset = the whole leg is a no-op.
BLUESKY_IDENTIFIER=op://$FLUNCLE_1PASSWORD_ENV_ITEM/BLUESKY_IDENTIFIER
BLUESKY_APP_PASSWORD=op://$FLUNCLE_1PASSWORD_ENV_ITEM/BLUESKY_APP_PASSWORD

VITE_FLUNCLE_SPOTIFY_PLAYLIST_URL=https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36
VITE_FLUNCLE_TELEGRAM_URL=https://t.me/fluncle

# R2 S3 API credentials for presigned direct-to-bucket uploads. R2_ACCOUNT_ID is
# non-secret and also lives in wrangler.jsonc for production, but local scripts
# read it from .dev.vars.
R2_ACCESS_KEY_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/R2_SECRET_ACCESS_KEY
R2_ACCOUNT_ID=0651fd3b33d9e0b2fe72a5f13e5cf65d

# Optional side-channels -- each no-ops when absent (readOptionalEnv in
# src/lib/server/env.ts), so local dev works unprovisioned. Uncomment a block
# and fill it from 1Password to exercise that leg.
# Resend -- the newsletter's send-of-record.
# RESEND_API_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/RESEND_API_KEY
# RESEND_SEGMENT_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/RESEND_SEGMENT_ID
# RESEND_FROM=op://$FLUNCLE_1PASSWORD_ENV_ITEM/RESEND_FROM
# Last.fm love-on-add (no-ops until LASTFM_SESSION_KEY is set).
# LASTFM_API_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/LASTFM_API_KEY
# LASTFM_SHARED_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/LASTFM_SHARED_SECRET
# LASTFM_SESSION_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/LASTFM_SESSION_KEY
# Discogs read-only release-ID enrichment.
# DISCOGS_USER_TOKEN=op://$FLUNCLE_1PASSWORD_ENV_ITEM/DISCOGS_USER_TOKEN
# Cloudflare cache purge-by-URL (falls back to local eviction when absent).
# CF_CACHE_PURGE_ZONE_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/CF_CACHE_PURGE_ZONE_ID
# CF_CACHE_PURGE_TOKEN=op://$FLUNCLE_1PASSWORD_ENV_ITEM/CF_CACHE_PURGE_TOKEN
# Expo push notifications for the mobile app.
# EXPO_ACCESS_TOKEN=op://$FLUNCLE_1PASSWORD_ENV_ITEM/EXPO_ACCESS_TOKEN
# OpenRouter context_note distil (falls back to raw snippets when absent).
OPENROUTER_API_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/OPENROUTER_API_KEY
OPENROUTER_CONTEXT_MODEL=op://$FLUNCLE_1PASSWORD_ENV_ITEM/OPENROUTER_CONTEXT_MODEL
# Hermes box agent Bearer -- the agent-role admin token (absent = operator-only).
# FLUNCLE_AGENT_TOKEN=op://$FLUNCLE_1PASSWORD_ENV_ITEM/FLUNCLE_AGENT_TOKEN

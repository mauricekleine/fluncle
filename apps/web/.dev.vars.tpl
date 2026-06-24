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
# Mixcloud needs no redirect-URI var — it's derived from the request origin.
MIXCLOUD_CLIENT_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/MIXCLOUD_CLIENT_ID
MIXCLOUD_CLIENT_SECRET=op://$FLUNCLE_1PASSWORD_ENV_ITEM/MIXCLOUD_CLIENT_SECRET

TELEGRAM_BOT_TOKEN=op://$FLUNCLE_1PASSWORD_ENV_ITEM/TELEGRAM_BOT_TOKEN
TELEGRAM_CHANNEL_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/TELEGRAM_CHANNEL_ID
DISCORD_WEBHOOK_URL=op://$FLUNCLE_1PASSWORD_ENV_ITEM/DISCORD_WEBHOOK_URL

VITE_FLUNCLE_SPOTIFY_PLAYLIST_URL=https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36
VITE_FLUNCLE_TELEGRAM_URL=https://t.me/fluncle

# R2 S3 API credentials for presigned direct-to-bucket uploads. R2_ACCOUNT_ID is
# non-secret and also lives in wrangler.jsonc for production, but local scripts
# read it from .dev.vars.
R2_ACCESS_KEY_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/R2_SECRET_ACCESS_KEY
R2_ACCOUNT_ID=0651fd3b33d9e0b2fe72a5f13e5cf65d

# Loops newsletter (transactional id is the published confirmation email)
LOOPS_API_KEY=op://$FLUNCLE_1PASSWORD_ENV_ITEM/LOOPS_API_KEY
LOOPS_TRANSACTIONAL_ID=op://$FLUNCLE_1PASSWORD_ENV_ITEM/LOOPS_TRANSACTIONAL_ID

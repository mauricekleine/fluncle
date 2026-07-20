# Dummy env for the E2E stack (tests/e2e). CI has no .dev.vars and no secrets, so
# the e2e boot materializes THIS file into `.dev.vars` for the run and restores
# the original afterwards (tests/e2e/stack.ts).
#
# EVERY VALUE HERE IS FAKE. Not one is a real credential, hostname, or op:// path.
# The outbound-integration keys exist only to satisfy env-shape checks — they are
# deliberately invalid, so nothing real can ever fire from a test run. If a spec
# needs an integration to actually respond, that is a mock's job, never a real key.

# The isolated libSQL server the e2e stack boots (tests/e2e/stack.ts, port 9440).
# The @cloudflare/vite-plugin injects THIS as the worker's DB binding.
TURSO_DATABASE_URL=http://127.0.0.1:9440
TURSO_AUTH_TOKEN=e2e-local-token

# Admin identity + signing. Fake — the e2e suite exercises PUBLIC surfaces, and the
# browser-fixture admin grant (tests/browser/admin.ts) mints against whatever secret
# is here, so a fake one is self-consistent.
FLUNCLE_API_TOKEN=e2e-fake-api-token
ADMIN_ALLOWED_EMAILS=e2e-admin@example.invalid
ADMIN_ALLOWED_SPOTIFY_IDS=e2efakespotifyid
ADMIN_SESSION_SECRET=e2e-fake-admin-session-secret-do-not-use
BETTER_AUTH_SECRET=e2e-fake-better-auth-secret-do-not-use
BETTER_AUTH_URL=http://127.0.0.1:3140

# Outbound integrations — all fake, all invalid on purpose.
FIRECRAWL_API_KEY=e2e-fake-firecrawl-key
CARTESIA_API_KEY=e2e-fake-cartesia-key
POSTIZ_API_KEY=e2e-fake-postiz-key
POSTIZ_API_URL=http://127.0.0.1:9/postiz-not-real

SPOTIFY_CLIENT_ID=e2e-fake-spotify-client-id
SPOTIFY_CLIENT_SECRET=e2e-fake-spotify-client-secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3140/api/admin/spotify/auth/callback
SPOTIFY_PLAYLIST_ID=e2efakeplaylistid

YOUTUBE_CLIENT_ID=e2e-fake-youtube-client-id
YOUTUBE_CLIENT_SECRET=e2e-fake-youtube-client-secret
YOUTUBE_REDIRECT_URI=http://127.0.0.1:3140/api/admin/youtube/auth/callback

MIXCLOUD_CLIENT_ID=e2e-fake-mixcloud-client-id
MIXCLOUD_CLIENT_SECRET=e2e-fake-mixcloud-client-secret

TELEGRAM_BOT_TOKEN=e2e-fake-telegram-bot-token
TELEGRAM_CHANNEL_ID=e2efakechannel
DISCORD_WEBHOOK_URL=http://127.0.0.1:9/discord-not-real

BLUESKY_IDENTIFIER=e2e-fake.example.invalid
BLUESKY_APP_PASSWORD=e2e-fake-app-password

# R2 presign creds — fake; the e2e suite uploads nothing.
R2_ACCESS_KEY_ID=e2efakeaccesskeyid
R2_SECRET_ACCESS_KEY=e2e-fake-secret-access-key
R2_ACCOUNT_ID=e2efakeaccountid

# Public client vars (safe fakes — never hit at test time).
VITE_FLUNCLE_SPOTIFY_PLAYLIST_URL=https://open.spotify.com/playlist/e2efakeplaylist
VITE_FLUNCLE_TELEGRAM_URL=https://t.me/e2efake

# OpenRouter — search/context distil degrade cleanly without it; left fake here.
OPENROUTER_API_KEY=e2e-fake-openrouter-key

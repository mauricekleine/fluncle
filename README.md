# Fluncle CLI

Local Bun/TypeScript CLI for publishing drum & bass tracks to Fluncle's Finest on Spotify and Telegram.

## Commands

```bash
fluncle add "https://open.spotify.com/track/..." --note "Absolute weapon"
fluncle add "https://open.spotify.com/track/..." --dry-run
fluncle auth spotify
```

## Operator Manual

### 1. Environment

Copy `.env.example` to `.env.local` and fill the missing Spotify and Telegram values. The Turso values are generated during setup.

```bash
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback
SPOTIFY_PLAYLIST_ID=

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=

TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
```

### 2. Spotify

1. Create a Spotify app in the Spotify Developer Dashboard.
2. Add this redirect URI to the app: `http://127.0.0.1:8787/callback`.
3. Put the client ID, client secret, and playlist ID in `.env.local`.
4. Run:

```bash
bun run fluncle auth spotify
```

5. Open the printed URL, approve access, and paste the full callback URL into the terminal.

The CLI stores Spotify OAuth tokens in Turso and refreshes the access token automatically.

### 3. Telegram

1. Create a bot with BotFather.
2. Add the bot to the Fluncle's Finest channel.
3. Give the bot permission to post messages.
4. Put the bot token and channel id or public `@channelname` in `.env.local`.

### 4. Database

Migrations are dev commands, not public CLI commands:

```bash
bun run db:generate
bun run db:migrate
```

## Publish Flow

`fluncle add` checks Turso for duplicates by Spotify track id. It inserts a pending row first, then adds the track to Spotify, then posts to Telegram. Each external operation is retried three times.

If Spotify fails, Telegram is not posted. If Spotify succeeds but Telegram fails, the database row is kept with `posted_to_telegram = false` for later inspection/recovery.

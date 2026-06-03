# Fluncle CLI

Local Bun/TypeScript CLI for publishing drum & bass tracks to Fluncle's Finest on Spotify and Telegram.

## Commands

```bash
fluncle add "https://open.spotify.com/track/..." --note "Absolute weapon"
fluncle add "https://open.spotify.com/track/..." --dry-run
fluncle recent --json
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

## Raycast Extension

The Raycast extension lives in `raycast/`. It is a thin client over the CLI and does not talk directly to Spotify, Telegram, or Turso.

### Commands

- `Fluncle: Quick Add`: reads the clipboard and immediately runs `fluncle add <url>`.
- `Fluncle: Add Track`: form with Spotify URL and optional note.
- `Fluncle: Recent Transmissions`: reads recent tracks through `fluncle recent --json`.

### Local Development

```bash
cd raycast
bun install
bun run build
bun run lint
bun run dev
```

The extension has one required preference:

```text
Fluncle CLI Path
```

Raycast runs with a minimal shell environment, so this should point to a standalone binary rather than a Bun-linked script. Build and install one locally:

```bash
bun build ./src/cli.ts --compile --target=bun-darwin-arm64 --outfile ./dist/fluncle-darwin-arm64
mkdir -p ~/.config/fluncle
install -m 600 ./.env.local ~/.config/fluncle/.env.local
install -m 755 ./dist/fluncle-darwin-arm64 ~/.local/bin/fluncle
```

Set the preference to:

```text
/Users/maurice/.local/bin/fluncle
```

The CLI must already be configured and authenticated locally. Test it before using Raycast:

```bash
fluncle recent --limit 3 --json
```

## Deploy To A VPS

The VPS does not need the source checkout. Build a standalone Linux binary locally, copy it to the server, and place config in the operator user's config directory.

### 1. Build The Binary

For a typical Linux x64 VPS:

```bash
bun build ./src/cli.ts --compile --target=bun-linux-x64-baseline --outfile ./dist/fluncle
```

For ARM64 Linux:

```bash
bun build ./src/cli.ts --compile --target=bun-linux-arm64 --outfile ./dist/fluncle
```

### 2. Copy Files To The Server

Replace `<host>` with your SSH target:

```bash
scp ./dist/fluncle ./.env.local <host>:/tmp/
```

### 3. Install On The Server

Run on the server:

```bash
mkdir -p ~/.config/fluncle
install -m 600 /tmp/.env.local ~/.config/fluncle/.env.local
sudo install -m 755 /tmp/fluncle /usr/local/bin/fluncle
rm -f /tmp/fluncle /tmp/.env.local
```

The CLI loads config from:

```text
~/.config/fluncle/.env.local
```

### 4. Verify

```bash
fluncle --help
fluncle add "https://open.spotify.com/track/..." --dry-run
```

## Publish Flow

`fluncle add` checks Turso for duplicates by Spotify track id. It inserts a pending row first, then adds the track to Spotify, then posts to Telegram. Each external operation is retried three times.

If Spotify fails, Telegram is not posted. If Spotify succeeds but Telegram fails, the database row is kept with `posted_to_telegram = false` for later inspection/recovery.

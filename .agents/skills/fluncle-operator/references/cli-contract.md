# CLI Contract

The CLI is the source of truth for Fluncle publishing. Keep business logic in `apps/cli/src/`, not in Raycast or the web app.

## Commands

```bash
bun run --cwd apps/cli fluncle add <spotify-url-or-uri> [--note "text"] [--dry-run] [--json]
bun run --cwd apps/cli fluncle recent [--limit 10] [--json]
bun run --cwd apps/cli fluncle auth spotify
```

Supported track inputs:

```text
https://open.spotify.com/track/<22-char-id>
spotify:track:<22-char-id>
```

## JSON Output

Raycast depends on `--json`. Preserve these broad shapes:

Success:

```json
{
  "ok": true,
  "track": {
    "trackId": "string",
    "spotifyUrl": "string",
    "title": "string",
    "artists": ["string"]
  },
  "dryRun": false,
  "addedToSpotify": true,
  "postedToTelegram": true,
  "message": "string"
}
```

Failure:

```json
{
  "ok": false,
  "code": "duplicate",
  "message": "Already published: Artist — Track"
}
```

Recent:

```json
{
  "ok": true,
  "transmissions": [
    {
      "trackId": "string",
      "spotifyUrl": "string",
      "title": "string",
      "artists": ["string"],
      "addedAt": "ISO timestamp",
      "addedToSpotify": true,
      "postedToTelegram": true
    }
  ]
}
```

## Publish Flow

`fluncle add` should:

1. Parse track ID.
2. Check Turso duplicate by `track_id`.
3. Fetch Spotify metadata.
4. If not dry-run, insert pending DB row.
5. Add to Spotify with retries.
6. Mark `added_to_spotify`.
7. Post to Telegram with retries.
8. Mark `posted_to_telegram`.

If Spotify fails, do not post to Telegram. If Telegram fails after Spotify succeeds, preserve the DB row with `posted_to_telegram = false`.

## Verification

Use a duplicate track for non-mutating checks:

```bash
bun run --cwd apps/cli fluncle add "spotify:track:2fyMcl41UQzD2WlBtJ0c8G" --json
```

Use recent for Turso/config checks:

```bash
bun run --cwd apps/cli fluncle recent --limit 1 --json
```

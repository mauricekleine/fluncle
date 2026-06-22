# CLI Contract

The deployed web app owns Fluncle server-side API routes. The CLI is a thin HTTP client for public reads and authenticated admin operations. Keep publishing mutations in `apps/web` server modules, not in Raycast.

## Commands

```bash
bun run --cwd apps/cli fluncle recent [--limit 10] [--json]
bun run --cwd apps/cli fluncle admin tracks queue [--limit 10] [--json]
bun run --cwd apps/cli fluncle admin tracks vehicles [--limit 10] [--json]
bun run --cwd apps/cli fluncle admin tracks publish <spotify-url-or-uri> [--note "text"] [--dry-run] [--json]
bun run --cwd apps/cli fluncle admin auth spotify
```

`recent` is the public feed, newest first — run bare in a terminal it pages interactively (←/→ for 10 at a time, `q` to quit); `--json`, an explicit `--limit`, or a non-TTY (piped) print plainly instead. The two admin reads query the archive directly — the order and no-video filters are applied in SQL and paged with a cursor, so they never undercount: `admin queue` lists findings with no video yet, oldest first (the first row is the next to film); `admin vehicles` lists recent `<logId> <date> <vehicle>` entries, newest first — the diversity ledger a video agent reads before choosing a vehicle.

Supported track inputs:

```text
https://open.spotify.com/track/<22-char-id>
spotify:track:<22-char-id>
```

## JSON Output

CLI and Raycast-style consumers depend on `--json`. Preserve these broad shapes:

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
  "tracks": [
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

`fluncle admin tracks publish` calls `POST /api/admin/tracks` with `Authorization: Bearer <FLUNCLE_API_TOKEN>`. The server should:

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
FLUNCLE_API_TOKEN=... bun run --cwd apps/cli fluncle admin tracks publish "spotify:track:2fyMcl41UQzD2WlBtJ0c8G" --json
```

Use recent for public API checks:

```bash
bun run --cwd apps/cli fluncle recent --limit 1 --json
```

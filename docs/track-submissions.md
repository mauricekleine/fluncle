# Track Submissions

## Goal

Let listeners submit Spotify tracks to Fluncle without publishing them immediately.
Submissions are reviewed by the operator and only become certified bangers in Fluncle's Findings through the existing authenticated admin add flow.

## Architecture

- `apps/web` owns Spotify, Turso, Discord, Telegram, and all mutation behavior.
- The CLI is a thin HTTP client for public reads/submissions and authenticated admin commands.
- Raycast is out of scope.
- Public clients do not parse Spotify URL-vs-query behavior. They send user input to `GET /api/search?q=...`, and the API decides whether it is a Spotify track URL/URI or a text search.
- Public clients always resolve input to one or more candidates, require selecting/confirming a candidate, then submit the selected candidate.
- A direct Spotify URL should return one visible candidate, not silently submit.

## Database

Add a `submissions` table.

Required fields:

```ts
{
  id: string;
  spotifyTrackId: string;
  spotifyUrl: string;
  title: string;
  artists: string; // JSON string array if needed
  album: string | null;
  artworkUrl: string | null;
  note: string | null;
  contact: string | null;
  source: "web" | "cli";
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
}
```

Recommended internal fields:

- `submitterHash`: hash of client IP or equivalent rate-limit key; do not store raw IP unless the user explicitly approves it.
- `statusReason` or `reviewNote` only if useful, not required for MVP.

Indexes:

- `status, createdAt`
- `spotifyTrackId`
- `submitterHash, createdAt` if used for rate limiting

Keep rejected submissions with status `rejected`.

## Public API

### `GET /api/search?q=...`

One endpoint handles both text search and Spotify track URL/URI resolution.

Behavior:

- Empty or too-short query returns a validation error.
- Spotify track URL or URI resolves exact track metadata and returns one result.
- Plain text searches Spotify tracks and returns multiple candidates.

Response:

```ts
{
  ok: true;
  results: Array<{
    id: string;
    title: string;
    artists: string[];
    album?: string;
    artworkUrl?: string;
    spotifyUrl: string;
  }>;
}
```

### `POST /api/submissions`

Body:

```ts
{
  spotifyTrackId: string
  spotifyUrl: string
  title: string
  artists: string[]
  album?: string
  artworkUrl?: string
  note?: string
  contact?: string
  source: "web" | "cli"
  honeypot?: string
}
```

Validation:

- Require selected track fields.
- `source` must be `web` or `cli`.
- Honeypot must be empty.
- Enforce max note length and max contact length.
- Apply basic rate limiting by IP-derived key. Prefer hashed keys or an internal DB field.

On success:

1. Insert pending submission.
2. Send Discord webhook notification.
3. Return JSON success.

Discord message:

```text
New Fluncle submission

Artist - Track
Source: web
Submitted by: @handle / email / unknown
Note: ...

Spotify: https://open.spotify.com/track/...
```

Use `allowed_mentions: { parse: [] }` for Discord webhook payloads.

## Admin API

Add authenticated routes for:

- List pending submissions.
- Fetch one submission.
- Reject one submission.
- Mark one submission approved after successful publish.

Do not publish directly from a status-only endpoint unless it still reuses the existing `publishTrack`/admin add path and preserves the dry-run-first confirmation requirement.

## Web

Add a compact action area on the home page with:

```text
[Submit a track] [Download the CLI] [DM me on X]
```

- `DM me on X` opens `https://x.com/mauricekleine` in a new tab.
- `Submit a track` opens a Shadcn/Base UI dialog.
- `Download the CLI` opens a Shadcn/Base UI dialog.

Submission dialog flow:

1. User enters search text or Spotify URL.
2. Dialog calls `/api/search`.
3. User selects a candidate.
4. User optionally adds note and contact info.
5. Dialog posts to `/api/submissions`.
6. Show loading, empty, error, and success states.

Keep the UI aligned with `PRODUCT.md`: dark-only, cover-led, centered, quiet, not a new marketing band. Prefer existing design tokens and local Shadcn/Base UI component patterns over broad custom CSS.

CLI dialog copy:

```text
Install the Fluncle CLI

curl -fsSL https://www.fluncle.com/cli/latest.sh | sh

Run:
fluncle --help
to get started.
```

Examples:

```bash
fluncle list
fluncle open
fluncle submit
fluncle submit "https://open.spotify.com/track/..."
```

## Public CLI

Add:

```bash
fluncle submit [input]
```

Behavior:

- With no args, start an interactive prompt asking for search input.
- With args, join them into one input string and send to `/api/search`.
- Render returned candidates with arrow-key navigation.
- Pressing Enter selects the highlighted candidate and submits it.
- Prompt for optional note.
- Prompt for optional contact.
- Submit to `POST /api/submissions` with source `cli`.

Example text search:

```text
$ fluncle submit "Camo & Crooked"
  Sientelo - Camo & Crooked
> Lose Control - Camo & Crooked
  Swerve It - Camo & Crooked

Press enter to submit
```

Example URL:

```text
$ fluncle submit "https://open.spotify.com/track/..."
> Sientelo - Camo & Crooked

Press enter to submit
```

Reuse or extract the existing selector logic from `apps/cli/src/commands/open.ts`.

## Admin CLI

Add:

```bash
fluncle admin submissions
fluncle admin submissions review <submission-id>
fluncle admin submissions reject <submission-id>
fluncle admin submissions approve <submission-id>
```

List output should include pending submissions with artist, title, source, contact, and note when present.

Approval flow:

1. Fetch submission.
2. Run existing add flow in dry-run mode:

   ```bash
   fluncle admin add "<spotify-url>" --dry-run
   ```

3. Print dry-run output.
4. Ask:

   ```text
   Publish this submission? (Y/n)
   ```

5. If confirmed, run real add flow:

   ```bash
   fluncle admin add "<spotify-url>"
   ```

6. Mark submission approved.

Reject sets status to `rejected` and does not delete the row.

## Verification

Required checks where feasible:

```bash
bun run format:check
bun run typecheck
bun run --cwd apps/web build
bun run --cwd apps/web lint
bun run --cwd apps/cli fluncle recent --limit 1 --json
```

Smoke tests:

- Public local flow without `FLUNCLE_API_TOKEN`: `/api/search`, `/api/submissions`, `fluncle submit`, and admin API unauthorized behavior.
- Admin local flow with `--env local` and token: list, reject, approve dry-run-first.
- Do not publish a real new track unless explicitly approved.
- Discord should only be exercised with a local/test webhook unless production notification is explicitly approved.

Stop and ask if Spotify auth is unavailable locally, if production Discord sends or real approval publishing would happen, or if durable rate limiting would require storing raw IPs.

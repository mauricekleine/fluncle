# Newsletter Cron Doctrine

The weekly newsletter runs as the **`fluncle-newsletter` Hermes agent cron** on the devbox (Friday 15:00 Europe/Amsterdam) — the same on-box automation home as the enrichment / context / observation crons. It authors the edition in Fluncle's voice, persists it as a **draft** server-side, then offers the operator a Discord **Send** button. The send stays operator-gated.

This file is the **authoring doctrine** — the window logic, the voice rails, the zero-find rule, the tidbit discipline. The self-contained cron prompt in [`hermes/cron/jobs.json`](./hermes/cron/jobs.json) (job `fluncle-newsletter`) restates it for the fresh, isolated session each Friday tick runs in; the operator wiring + the DST and `clarify`-gate mechanics live in [`hermes/cron/README.md`](./hermes/cron/README.md). The server build (the `editions` table, the Resend Broadcast send, the `/newsletter` archive) is the RFC's: [`docs/rfcs/newsletter-own-the-stack.md`](../rfcs/newsletter-own-the-stack.md). This doc consumes it.

## The shape (Hermes + Resend, not Spinup + Loops)

- **Compute:** an on-box Hermes **agent** cron (Sonnet + the installed `copywriting-fluncle` skill). Not a `--no-agent` script — the newsletter authors copy, so it needs the LLM. Each Friday tick is a fresh session, so the prompt is fully self-contained.
- **Persist:** the authored edition is written as a **draft `editions` row** (no number yet) via `fluncle admin newsletter draft` (Worker op `create_edition`, admin tier — agent-allowed). This is the durable artifact; it happens **before** the send button (persist-then-offer), so a missed button never loses the work.
- **Send:** the operator taps the Discord **Send** button (the `clarify` gate) → the agent calls `fluncle admin newsletter send <id>` (Worker op `send_edition`, **operator tier** — a valid agent token gets a 403). The Worker renders the email HTML from the stored `content`, creates + sends the **Resend broadcast**, and mints the sequential edition number. The send is the human gate that replaces the old Loops dashboard tap.
- **Secrets:** `RESEND_API_KEY` + the segment id stay **Worker secrets**. The box holds only its agent-scoped admin token; it never touches Resend directly.
- **Archive:** the sent edition lands in the `/newsletter` archive — the same structured `content` payload renders both the email HTML and the archive page (one source → two renders).

The CLI relays the cron uses (Convention B `verb_noun`): `fluncle admin newsletter draft|update|send|list` — `draft`=`create_edition`, `update`=`update_edition`, `send`=`send_edition` (operator-only), `list`=`list_editions_admin` (drafts inclusive, the miss-recovery read).

## Voice (non-negotiable)

You are Fluncle: the uncle with the good records, writing a letter to the people on his list. Load and apply the **`copywriting-fluncle`** skill (installed on the box at `~/.hermes/skills/copywriting-fluncle`) — it is the full voice canon and overrides everything below. The rules that most often save you:

- Email register: a letter from a bruv. Open with "Ahoy cosmonauts," close with "Happy raving," then "Fluncle". First person ("I"), no "we".
- No exclamation marks, no marketing buzzwords, never the words "transmission", "signal" (as identity), "curated", or "content". The collection is "Fluncle's Findings"; dates are "Found".
- "Banger" at most once per paragraph; "track" and "tune" carry repeats.
- Track lines are `Artist — Title` (em dash); that em dash is the only one allowed.
- Cosmos verbs are allowed as first-person testimony ("this one teleported me to a parallel universe"), never as functional labels.
- If a sentence reads drafted rather than said out loud to a mate, rewrite it.

## The window (self-healing, keyed off the last SENT edition)

The discovery window is `[since, until)`. `until` is NOW. `since` is the `windowUntil` of the most recent **sent** edition (read it from `fluncle admin newsletter list --json`, the row with status `sent` and the highest `number`); if no edition has ever been sent, use NOW minus 7 days.

Only **sent** editions anchor the window — that is what makes it self-heal. A skipped Friday, or a drafted-but-never-sent edition, leaves the window open: the next run's `since` is still the last _sent_ cutoff, so those finds re-enter the next window instead of being dropped. (This replaces the old "parse the cutoff out of the Loops campaign name" hack — the cutoff now lives in `editions.windowUntil`, a real column.)

**Miss-recovery comes first.** Before authoring anything, read `admin newsletter list` for an existing **unsent draft** (status `draft`, no `number`). If one exists, do not author a new edition — re-offer _that_ draft's Send button. The draft is updated in place, never duplicated; the send is idempotent on the edition id, so a re-offered button never double-mails.

## The content (one structured payload)

Author the structured `content` payload the archive page and the email HTML both render from, and hand it to `admin newsletter draft --content-file <edition.json>`:

1. **Fetch the finds.** `GET https://www.fluncle.com/api/tracks?since=<SINCE>&until=<NOW>&limit=48`, paging with `cursor` while `nextCursor` is returned.
2. **Mixtapes.** `GET https://www.fluncle.com/api/mixtapes` (newest first, no window params). Keep only those whose `addedAt` falls inside SINCE..NOW. A mixtape is Fluncle's own DJ set consolidating finds — optional and usually rare. None in the window means no mixtape section; never invent one or stretch the window to find one.
3. **Zero-find rule.** If the window has no tracks and no mixtapes, author nothing and send nothing. A missed Friday is quieter than a hollow one. (A window with only a mixtape and no tracks is still worth an edition — the mixtape is the edition.)
4. **The why.** Each track's `note` is Fluncle's own words on why it made the cut — your primary material; quote or lightly adapt it. Never invent a reason for a track with no note; describe it plainly or let the title stand alone. A mixtape's `note` is its dream note; treat it the same.
5. **Per-track block** (newest first): the `Artist — Title` line (em dash), the why as its own breath, a link to the finding's log page (its permanent home), and a quiet inline Spotify link so both are one tap away.
6. **Mixtape block** (per mixtape from step 2, newest first): a clean `Mixtape #<n>` label linking the mixtape's log page, the dream note, and a quiet inline link for each home the set has (Mixcloud first when present, then YouTube, then SoundCloud).
7. **Tidbits (optional, strict).** Recent, concrete, source-linked artist news only — album/EP announcements, tours, label signings — and only when you are confident it is the same artist (drum & bass aliases collide with mainstream names; when unsure, drop it). At most 2–3, each with its source link. Nothing found means no tidbit section. Never fabricate or embellish.
8. **Subject:** short, dry, specific to this week's contents; sentence case; no exclamation marks.

## Safety rails

- **Persist before the button, always.** The draft row is the durable artifact; the Send button is convenience. Author + `admin newsletter draft` first, _then_ offer `clarify`.
- **Never send unprompted; never auto-send on a `clarify` timeout.** Silence is treated as Hold — it is not consent for a publish-class action. The draft persists and is re-offered next Friday.
- **The send is operator-only by design.** Your agent token gets a 403 on `admin newsletter send`. Do not work around it; offer the button and let the operator tap.
- **Every fact comes from the API response or a source-linked tidbit.** The uncle never makes things up; the music is impressive enough. Never invent a track, artist, date, Log ID, or stat.
- **One draft per window, updated not duplicated.** Re-running finds the existing unsent draft and re-offers it rather than authoring a second one.

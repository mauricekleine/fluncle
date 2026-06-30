# Newsletter Cron Doctrine

The weekly newsletter runs as the **`fluncle-newsletter` Hermes `--no-agent` sweep** on the devbox (Friday 15:00 Europe/Amsterdam) — the same on-box automation home as the enrichment / context / observation sweeps. It is deterministic end to end (window → gather → persist → deliver) except **one** bounded `claude -p` authoring call that writes the edition copy in Fluncle's voice. It persists the edition as a **draft** server-side, then posts a one-line Discord summary + the `fluncle admin newsletter send <id>` command. The send stays operator-gated.

This file is the **authoring doctrine** — the window logic, the voice rails, the zero-find rule, the tidbit discipline. The sweep source ([`hermes/scripts/newsletter-sweep.{sh,ts}`](./hermes/scripts/)) restates the authoring prompt for the fresh, isolated `claude -p` call each Friday tick makes; the operator wiring + the DST mechanics live in [`hermes/cron/README.md`](./hermes/cron/README.md). The server build (the `editions` table, the Resend Broadcast send, the `/newsletter` archive) has shipped; this doc is the authoring layer on top of it.

## The shape (Hermes + Resend, not Spinup + Loops)

- **Compute:** an on-box Hermes **`--no-agent` sweep** — deterministic window/gather/persist/deliver with **one** bounded `claude -p` authoring call (Claude Code on subscription auth + the baked `copywriting-fluncle` skill; zero OpenRouter). The newsletter authors copy, so that one step needs the LLM — but it is a single call, not a full agent session. (It replaced the old full-agent cron on 2026-06-27, after an agent run flailed 83 model calls on one trigger.) Each Friday tick is a fresh, self-contained invocation.
- **Persist:** the authored edition is written as a **draft `editions` row** (no number yet) via `fluncle admin newsletter draft` (Worker op `create_edition`, admin tier — agent-allowed). This is the durable artifact; it happens **before** the Discord offer (persist-then-offer), so a missed send never loses the work.
- **Send:** the sweep posts a one-line Discord summary + the literal `fluncle admin newsletter send <id>` command; the **operator** runs it (Worker op `send_edition`, **operator tier** — a valid agent token gets a 403). The Worker renders the email HTML from the stored `content`, creates + sends the **Resend broadcast**, and mints the sequential edition number. The operator-run command is the human gate that replaces the old Loops dashboard tap. (The old interactive `clarify` Send/Hold button needed the agent loop and is gone with it.)
- **Secrets:** `RESEND_API_KEY` + the segment id stay **Worker secrets**. The box holds only its agent-scoped admin token; it never touches Resend directly.
- **Archive:** the sent edition lands in the `/newsletter` archive — the same structured `content` payload renders both the email HTML and the archive page (one source → two renders).

The CLI relays the cron uses (Convention B `verb_noun`): `fluncle admin newsletter draft|update|send|list` — `draft`=`create_edition`, `update`=`update_edition`, `send`=`send_edition` (operator-only), `list`=`list_editions_admin` (drafts inclusive, the miss-recovery read).

## Voice (non-negotiable)

You are Fluncle: the uncle with the good records, writing a letter to the people on his list. Load and apply the **`copywriting-fluncle`** skill (baked into the image at `/opt/claude/skills/copywriting-fluncle`, discovered via `CLAUDE_CONFIG_DIR=/opt/claude` so the `claude -p` authoring call finds it) — it is the full voice canon and overrides everything below. The rules that most often save you:

- Email register: a letter from a bruv. Open with "Ahoy cosmonauts," close with "Happy raving," then "Fluncle". First person ("I"), no "we".
- No exclamation marks, no marketing buzzwords, never the words "transmission", "signal" (as identity), "curated", or "content". The collection is "Fluncle's Findings"; dates are "Found".
- "Banger" at most once per paragraph; "track" and "tune" carry repeats.
- Track lines (`Artist — Title`, with the only allowed em dash) are rendered FROM the finding ref, not authored — your payload carries just `{ logId, why }` per finding. Keep prose to the `intro` and each finding's `why`.
- Cosmos verbs are allowed as first-person testimony ("this one teleported me to a parallel universe"), never as functional labels.
- If a sentence reads drafted rather than said out loud to a mate, rewrite it.

## The window (self-healing, keyed off the last SENT edition)

The discovery window is `[since, until)`. `until` is NOW. `since` is the `windowUntil` of the most recent **sent** edition (read it from `fluncle admin newsletter list --json`, the row with status `sent` and the highest `number`); if no edition has ever been sent, use NOW minus 7 days.

Only **sent** editions anchor the window — that is what makes it self-heal. A skipped Friday, or a drafted-but-never-sent edition, leaves the window open: the next run's `since` is still the last _sent_ cutoff, so those finds re-enter the next window instead of being dropped. (This replaces the old "parse the cutoff out of the Loops campaign name" hack — the cutoff now lives in `editions.windowUntil`, a real column.)

**Miss-recovery comes first.** Before authoring anything, read `admin newsletter list` for an existing **unsent draft** (status `draft`, no `number`). If one exists, do not author a new edition — re-offer _that_ draft's send command. The draft is updated in place, never duplicated; the send is idempotent on the edition id, so a re-offered command never double-mails.

## The content (one structured payload)

Author the structured `content` payload the archive page and the email HTML both render from, and hand it to `admin newsletter draft --content-file <edition.json>`. The payload is `EditionContentSchema` (`packages/contracts/src/orpc/_shared.ts`): galaxy-grouped finds where each finding is the tiny ref `{ logId, why }` — NOT a prose block. The render hydrates each `logId` to its live `Artist — Title` + Spotify link itself (`edition-email.ts` → `getTracksByLogIds`), so the payload carries no artist/title/links; keeping the ref tiny is what keeps the email current as a finding's metadata changes.

```json
{
  "intro": "<1–3 sentences, the week in one breath, first person>",
  "galaxies": [
    {
      "galaxy": "Solar",
      "findings": [{ "logId": "021.7.1A", "why": "<the why; OMIT when the finding has no note>" }]
    }
  ],
  "mixtapeRef": "019.F.1A",
  "tidbits": [{ "text": "<a recent, concrete artist fact>", "source": "<the source URL>" }]
}
```

1. **Fetch the finds.** `GET https://www.fluncle.com/api/tracks?since=<SINCE>&until=<NOW>&limit=48`, paging with `cursor` while `nextCursor` is returned. Each finding carries `logId`, `galaxy` (`{key, name}`, or ABSENT when unplaced on the vibe map), and `note` — all already on the public DTO (`toTrackListItem`); `galaxy` derives from `vibe_x`/`vibe_y` and already powers the public `/log` pages, so no admin read is needed.
2. **Mixtapes.** `GET https://www.fluncle.com/api/mixtapes` (newest first, no window params). Keep only those whose `addedAt` falls inside SINCE..NOW. A mixtape is Fluncle's own DJ set consolidating finds — optional and usually rare. None in the window means no `mixtapeRef`; never invent one or stretch the window to find one.
3. **Zero-find rule.** If the window has no tracks and no mixtapes, author nothing and send nothing. A missed Friday is quieter than a hollow one. (A window with only a mixtape and no tracks is still worth an edition — the mixtape is the edition.)
4. **Group BY GALAXY.** One `galaxies[]` block per galaxy that has finds this window. Order the blocks Solar, Nebular, Lunar, Astral; findings within a block newest-first. The block's `galaxy` is the galaxy NAME string (`galaxy.name` from the API). Findings with no `galaxy` go in a final block whose `galaxy` is the literal `"Also found"`.
5. **The why.** Each finding's `note` is Fluncle's own words on why it made the cut — your primary material for that finding's `why`; quote or lightly adapt it. Never invent a reason for a finding with no note — OMIT the `why` field for it. A finding ref is ONLY `{ logId, why }`; never put artist, title, or links in the payload (the render adds those).
6. **Mixtape.** Set `mixtapeRef` to the mixtape's `logId` (e.g. `019.F.1A`) only when one fell in the window; omit the field otherwise. The render hydrates it like any finding. (One per window in practice; the schema carries a single ref.)
7. **Tidbits (optional, strict).** Recent, concrete, source-linked artist news only — album/EP announcements, tours, label signings — and only when you are confident it is the same artist (drum & bass aliases collide with mainstream names; when unsure, drop it). At most 2–3, each `{ text, source }`. Nothing found means omit `tidbits`. Never fabricate or embellish.
8. **Subject:** short, dry, specific to this week's contents; sentence case; no exclamation marks. (Passed via `--subject`, not in the payload.)

The `"Ahoy cosmonauts,"` open and `"Happy raving," / "Fluncle"` close are added by the render — keep them out of `intro`. The `why` lines and `intro` are the only prose you author.

## Safety rails

- **Persist before the offer, always.** The draft row is the durable artifact; the Discord summary is convenience. Author + `admin newsletter draft` first, _then_ post the summary + the send command.
- **Never send unprompted; never auto-send.** Silence is treated as Hold — it is not consent for a publish-class action. The draft persists and is re-offered next Friday.
- **The send is operator-only by design.** Your agent token gets a 403 on `admin newsletter send`. Do not work around it; post the `fluncle admin newsletter send <id>` command and let the operator run it.
- **Every fact comes from the API response or a source-linked tidbit.** The uncle never makes things up; the music is impressive enough. Never invent a track, artist, date, Log ID, or stat.
- **One draft per window, updated not duplicated.** Re-running finds the existing unsent draft and re-offers it rather than authoring a second one.

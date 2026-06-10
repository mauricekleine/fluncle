---
name: fluncle-bpm-backfill
description: >-
  MANUAL, approval-gated repair tool for fixing a Fluncle track's stored BPM when
  it is null or a stale/fake value (e.g. an old clamped 160). It re-derives the
  REAL tempo from two out-of-band sources the automated preview analyzer can't
  use: AcousticBrainz metadata by ISRC (free, instant, zero-risk), and — only as a
  fallback — full-song audio pulled transiently via yt-dlp and re-analyzed with
  Fluncle's own BPM DSP, then deleted. Use this ONLY when the user explicitly asks
  to backfill / fix / re-derive a track's BPM, mentions a wrong, fake, missing, or
  stale-160 BPM, or invokes it by name (e.g. "please use /fluncle-bpm-backfill").
  This is NOT part of automated enrichment and must never run on its own — it
  downloads audio and writes to the production database, so it requires an explicit
  human trigger and per-track confirmation before any write.
---

# Fluncle BPM Backfill

A hands-on repair tool for the handful of tracks whose stored `bpm` is wrong or
missing. The automated enrichment agent only ever sees a 30-second preview; some
drum & bass previews are beatless build-ups, so the analyzer honestly returns
`null` (or, from older clamping code, a fake `160`). This skill exists to fix
those specific tracks using sources the automated path deliberately avoids.

## When this runs (and when it must NOT)

This is an **exception path**, not a pipeline step. Run it only when a human
explicitly asks — by name, or with a clear request like "the BPM for Teddy's Gate
is wrong, re-derive it" or "backfill the tracks that have no BPM." 

Never invoke it as a follow-on to enrichment, never batch the whole catalog
through it, and never treat it as the default way to get a BPM. The automated
preview path stays the source of truth for normal adds; the microVM keeps its
clean, legally-sound posture precisely because it does **not** download full
songs. Keep usage to the real exception rate — a few tracks, on demand (think
≤10/day, and usually far fewer).

Two hard rules, because this tool has real-world side effects:

1. **It mutates the production database** (via the authenticated admin API). Get
   explicit per-track confirmation of the exact value before every write.
2. **The YouTube tier downloads copyrighted audio.** That is acceptable only as a
   transient, human-authorized, small-scale local operation: analyze, then delete
   the audio immediately. Run it **locally, never on the microVM** (which must
   stay clean), and never automate or scale it.

## The repair ladder

Work cheapest-and-safest first. Stop as soon as a tier yields a confident,
in-band result you and the user trust.

```
0. Identify the target track(s)        →  read-only, safe
1. AcousticBrainz by ISRC              →  free, no auth, zero matching risk
2. YouTube full-audio (fallback only)  →  local, transient, guarded, delete after
3. Confirm + write back                →  explicit human approval per track
   else: leave it null — never write a guess
```

### Step 0 — Identify the target(s)

If the user named a specific track (id or log id), fetch it. Otherwise, in
discovery mode, list candidates and ask which to process — do not act on the
whole list automatically.

```bash
# A specific track:
bun run --cwd apps/cli fluncle track get <trackId|logId> --json

# Discovery: tracks worth re-checking are bpm == null, or an exact clamp value
# (160.00 / 185.00) that the old code produced. Exact-160 is SUSPECT, not proven
# fake — a track can legitimately be 160 — so always re-derive and compare.
bun run --cwd apps/cli fluncle recent --json --limit 100
```

From the track record, capture: `trackId`, `isrc`, `artists`, `title`,
`durationMs`, `spotifyUrl`, and the current stored `bpm`. You need the ISRC for
tier 1 and the duration for tier 2's match guard.

### Step 1 — AcousticBrainz by ISRC (try this first, always)

AcousticBrainz holds precomputed Essentia analysis (including `rhythm.bpm`) keyed
by MusicBrainz recording ID. It is free, needs no auth, and carries **zero
matching risk** because we resolve it by ISRC — the exact recording. The catch:
the project froze in 2022, so it 404s on anything never submitted (newer releases
especially). When it has the track, the BPM is trustworthy and already in-band.

Two HTTP calls. **Send a descriptive `User-Agent`** — MusicBrainz requires one and
rate-limits to ~1 request/second.

```bash
ISRC="USAT21602393"
UA="fluncle-bpm-backfill/1.0 ( hey@mauricekleine.com )"

# 1a. ISRC → MusicBrainz recording MBID. Pick the recording whose artist+title
#     match the track; if several, prefer the canonical release.
curl -s -H "User-Agent: $UA" \
  "https://musicbrainz.org/ws/2/recording?query=isrc:${ISRC}&fmt=json" \
  | jq '.recordings[] | {id, title, artist: [.["artist-credit"][].name]}'

# 1b. MBID → AcousticBrainz BPM. 404 means "not in the archive" → fall through.
MBID="<chosen-mbid>"
curl -s -H "User-Agent: $UA" \
  "https://acousticbrainz.org/api/v1/${MBID}/low-level" \
  | jq '{bpm: .rhythm.bpm, title: .metadata.tags.title, artist: .metadata.tags.artist}'
```

Sanity-check the result before trusting it: the artist/title in the response
should match the track, and the BPM should sit in (or octave-fold into) the
160–185 D&B band. If it checks out, this is your candidate value (source:
`acousticbrainz`). If it 404s or looks wrong, go to Step 2.

### Step 2 — YouTube full-audio (fallback only, when tier 1 misses)

If AcousticBrainz has nothing, re-derive the BPM from the **full song** with
Fluncle's own algorithm. The preview failed only because it was 30s of build-up;
the full track has the beat. Requires `yt-dlp` and `ffmpeg` on PATH (local only).

**The dominant risk is grabbing the wrong upload.** A sped-up / "nightcore"
reupload would yield a confidently-wrong in-band number — worse than null. So
**inspect candidates before downloading** and apply strict guards.

```bash
ARTIST="Whiney, LaMeduza"; TITLE="Teddy's Gate"
DUR_MS=309943   # from the track record; match within a few seconds

# 2a. Inspect the top hits WITHOUT downloading — uploader, duration, title.
yt-dlp --skip-download --print "%(duration)s | %(uploader)s | %(title)s | %(webpage_url)s" \
  "ytsearch6:${ARTIST} ${TITLE}"
```

Choose the upload that satisfies ALL of these — otherwise stop and ask the human:

- **Uploader** is the official artist channel or the auto-generated `<Artist> - Topic` channel (Topic uploads are clean masters — strongly prefer them).
- **Duration** matches `durationMs` within ~±3s.
- **Title** does NOT contain: `remix`, `nightcore`, `sped up`, `spedup`, `slowed`, `bootleg`, `mashup`, `cover`, `live`, `edit`. (`VIP` can be an official version — judge in context, don't auto-reject.)

```bash
# 2b. Download bestaudio only to a temp dir.
WORK="$(mktemp -d)"
yt-dlp -f bestaudio -o "${WORK}/audio.%(ext)s" "<chosen-url>"

# 2c. Analyze with Fluncle's DSP (multi-window consensus + whole-track pass).
bun "$(dirname "$0")/scripts/analyze-local.ts" --audio-file "${WORK}"/audio.*

# 2d. ALWAYS delete the audio — on success or failure.
rm -rf "${WORK}"
```

> Run 2b–2d so the cleanup in 2d happens no matter what (e.g. wrap in a function
> with a `trap 'rm -rf "$WORK"' EXIT`, or delete in a `finally`). Never leave
> downloaded audio on disk.

`analyze-local.ts` prints JSON: the multi-window `bpm` + `confidence` +
`agreement` (how many windows voted for it) + `windows` (total), plus a
`wholeTrack` cross-check. Trust the result when the multi-window and whole-track
values agree and `agreement` is a healthy fraction of `windows`. Source:
`youtube-fullaudio`.

### Step 3 — Confirm, then write back

Present everything to the user and get an explicit go-ahead **per track**. Show:

- current stored `bpm` (and whether it's null or a suspect clamp value)
- AcousticBrainz value (if any)
- YouTube value + confidence + window agreement (if used), and the **exact upload
  you analyzed** (title, uploader, duration) so the human can verify the match
- the value you propose to write and its provenance source

When two tiers both produced a value, they should agree within ~1–2%; converging
independent methods is the strongest signal you have the real tempo. If they
disagree, surface it and let the human decide rather than picking silently.

On approval, write it:

```bash
bun run --cwd apps/cli fluncle admin track update <trackId> --bpm <value>
```

Then state the provenance plainly in your summary (e.g. "wrote 172.27, source:
acousticbrainz" / "wrote 173.00, source: youtube-fullaudio, conf 0.64, 17/37
windows, from the Whiney - Topic upload"). There is currently **no `bpm_source`
column** in the schema, so provenance lives in this report, not the database — do
not invent a field. (Persisting a source column is reasonable future work; mention
it if the user wants an audit trail, but don't build it as part of a backfill.)

## When to abstain

If neither tier yields a confident, in-band result you trust, **leave the track
as-is** (null is honest; a stale fake stays flagged for next time). Writing a
guessed or wrong-match BPM is the one outcome this tool must never produce — it
would launder uncertainty into false confidence, exactly what the analyzer's
null-over-fake design prevents. A track left null can be retried later; a wrong
number silently corrupts the catalog.

## Notes

- The BPM DSP in `scripts/analyze-local.ts` is a faithful copy of the enrichment
  skill's `analyze-track.ts:estimateBpm` (same band-split, onset envelope,
  autocorrelation, octave-fold). It is self-contained because installed skills are
  copied independently — keep it in sync if the core DSP changes.
- `yt-dlp` is a heavy, fast-moving dependency (it tracks YouTube's player and
  breaks if stale). That's another reason this is a local, on-demand tool and not
  something the clean automated microVM should ever carry.

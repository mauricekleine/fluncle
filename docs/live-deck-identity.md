# Live deck identity — reading what Rekordbox has loaded, and resolving it to a finding

The live show has two orthogonal questions, and it is a mistake to solve them with one signal:

- **IDENTITY** — _what_ track is on a deck. The DJ's intended track name lives in exactly one place before a single note is heard: Rekordbox's deck header. We read it with native macOS OCR.
- **CHANGE** — _which_ deck went live, and _when_. That is the crossfader/channel-fader state, which the MIDI mixer-state feed already solves (a separate concern, a separate PR).

Keeping them orthogonal is the whole design. The MIDI feed knows a deck went live at 21:47:03 but not what is on it; the OCR knows a deck holds "Strength (Original Mix)" but not whether it is audible. Fuse them at the bridge: when CHANGE says "deck 2 is now live", IDENTITY says "deck 2 is 011.1.6E", and the glass arrives at that finding.

This doc owns IDENTITY. The pieces:

- `packages/live/scripts/deckwatch/deckwatch.py` — capture → crop → Vision OCR → `{title, artist, bpm, key}` per deck.
- `packages/live/src/bridge/identity.ts` — a **pure** resolver (`resolveDeck`) from an OCR'd header to an archive finding, or `null`.
- `packages/live/src/bridge/identity.test.ts` — the ground-truth decks, the null rail, every OCR gotcha.

## Event-driven, not polling

OCR is not free (a full read is ~260ms: ~120ms capture + ~140ms/deck OCR, measured live). Polling it at frame rate would be absurd. It does not need to be: a deck header only changes when the DJ loads a new track — a handful of times across an hour. So `deckwatch --watch` hashes the **cropped strip bytes** each tick and OCRs a deck _only when its strip changed_. Between loads it does nothing but a cheap capture+hash. One read per transition; a 260ms read against a several-minutes-per-track set is free.

The natural trigger is the CHANGE signal itself: a deck going live is exactly when you want a fresh identity read. That makes the whole thing event-driven end to end — no timer, no drift.

## The capture path (position-independent, no computer-use)

1. **Find the window.** Quartz `CGWindowListCopyWindowInfo`; owner name contains `rekordbox`, width > 800 (skip palettes/tooltips). Window metadata needs no capture permission.
2. **Capture just that window.** `screencapture -x -o -l <windowid> out.png`. Capturing _the window_ (not a screen region) means it follows Rekordbox around the desktop — no magic pixel coordinates that break when a window moves. A 1512×949 logical window captures at 3024×1898 px (2× Retina).
3. **Crop the deck strips.** Validated fractional rects, **TOP-left origin**, as fractions of the window image: deck 1 `(0.020, 0.215, 0.355, 0.278)`, deck 2 `(0.553, 0.215, 0.860, 0.278)`.
4. **OCR.** Apple Vision `VNRecognizeTextRequest`, `accurate` level, **language correction OFF** (a DJ's track titles are not English prose; correction hurts). Via pyobjc (`pyobjc-framework-Quartz`, `pyobjc-framework-Vision`).

The process running `deckwatch.py` must hold **Screen Recording** permission (System Settings › Privacy & Security). Without it `screencapture` returns a blank image and Vision reads nothing — the script detects "no text on either deck" and says so rather than emitting garbage.

## The resolver — title+artist is the identity, bpm/key are coarse guards

`resolveDeck(observed, findings)` returns `{ index, score, reason }` or `null`.

- **PRIMARY signal: fuzzy title + artist.** Against a ~60-item archive this is near-unambiguous on its own. Title carries the identity (weighted 0.7), artist confirms (0.3). Matching normalizes both sides: lowercase, strip accents, `&` ↔ `and`, drop `feat. …`, strip leading punctuation, collapse whitespace. Edit-distance ratio, lifted by token containment so a truncated OCR title ("I See The Future") still scores against the full one ("I See The Future In Your Eyes").
- **Remix/VIP/edit is identity, and a HARD gate.** "Original Mix" / "Extended Mix" / "Radio Edit" / "Album Version" are _neutral_ and stripped, so Rekordbox's "Strength (Original Mix)" matches the archive's bare "Strength". But Remix / VIP / Edit / Bootleg / Flip / Rework / Dub / … are a _different recording_: they form a version signature, and a finding whose signature differs is skipped entirely. Token containment alone would score "Deadweight (X Remix)" against "Deadweight" high enough to cross the threshold — the gate is what stops a remix ever resolving to the original.
- **Below threshold → `null`.** This is the never-show-the-wrong-finding rail. It fires both when OCR is noise _and_ when the DJ simply plays a track that isn't a finding. The caller then falls back to a random-VJ scene — a generic beautiful thing, never the wrong specific thing.

### Why bpm and key are guards, never the identity

Measured live against the archive:

| finding    | Rekordbox header                                                            | Fluncle archive               |
| ---------- | --------------------------------------------------------------------------- | ----------------------------- |
| `019.1.7X` | `Strength (Original Mix)` / Technimatic / **174.00** / `6A`                 | bpm **172.56**, key `G major` |
| `011.1.6E` | `I See The Future In Your Eyes (Original Mix)` / Netsky / **173.00** / `5A` | bpm **171.09**, key `C minor` |

Two lessons, both load-bearing:

- **bpm disagrees systematically.** Fluncle's stored DSP bpm reads ~1.5 low vs Rekordbox (172.56 vs 174.00; 171.09 vs 173.00). So the bpm guard accepts within ±3 — or half/double-time within ±3 — and only ever _nudges_ a match up. It never rejects a strong title+artist match, never accepts on its own. 4/48 findings have no bpm at all.
- **key mode disagrees.** Rekordbox's `6A` is **G minor**; the archive stores `G major` for the same track. The tonic (G) agrees; the mode does not. So the key guard compares **tonic only, ignoring mode**. Same nudge-only role. 5/48 findings have no key.

Neither can be the identity: both are nullable, both disagree with the archive in predictable ways, and confidence is no help (see below). They are a tie-breaker on top of a title+artist match that is already near-certain.

### The Camelot map

Rekordbox may display the key as **Camelot** (`6A`) or **Classic** (`Gm`) depending on a user preference; the resolver accepts both, plus Fluncle's sharp-spelled scale text (`"G major"`, `"A# minor"`). Everything reduces to a 0–11 tonic pitch class (enharmonics share a class, which is what a tonic-only compare wants).

Verified against the table above — `5A` must be C minor and `6A` must be G minor, which is exactly how it was validated live:

- minor `1A..12A` → Ab, Eb, Bb, F, **C**, **G**, D, A, E, B, F#, Db
- major `1B..12B` → B, F#, Db, Ab, Eb, Bb, F, C, G, D, A, E

## OCR gotchas — every one is handled

1. **Homoglyphs.** Vision returned deck 2's key as `5А` with a **non-Latin (Cyrillic) А**. A naive compare silently never matches. Both `deckwatch.py` and `identity.ts` fold Cyrillic/Greek lookalikes to Latin before anything else.
2. **Deck-number badge bleed.** Deck 2's title came back as `- I See The Future…`. Leading non-alphanumerics are stripped (in the OCR parse _and_ in the resolver's normalizer, so either layer is robust alone).
3. **Confidence is not a validity signal.** Vision reported 1.00 while misreading chrome (`HIGH` → `HICH`). We never read `confidence`; we trust the cross-checks (title+artist agreement, the bpm/key guards) instead.
4. **A title splits across observations on one line.** Vision may return a title as several fragments. The parser bins observations into y-bands and orders each band left-to-right before joining.
5. **Layout dependence.** The crop rects assume the **2-deck performance view**. If the parsed second line carries no bpm, the crop probably missed the header, so `deckwatch.py` re-OCRs the whole window and selects the header _structurally_ — the title line sitting just above the bpm-bearing line, on the correct half.

## Running it

```bash
# one shot — OCR both decks, print one JSON object
python3 packages/live/scripts/deckwatch/deckwatch.py --once

# event-driven — a JSON line per deck, only when that deck's strip changes
python3 packages/live/scripts/deckwatch/deckwatch.py --watch
```

Requires the two pyobjc frameworks and Screen Recording permission for the running process. The committed strips under `scripts/deckwatch/fixtures/` (`deck1-strength.png`, `deck2-future.png`) are the real deck-2/deck-1 headers cropped from the live capture — small, and enough to re-validate the OCR parse offline. The pure resolver is fully covered by `identity.test.ts` and needs neither macOS nor a capture.

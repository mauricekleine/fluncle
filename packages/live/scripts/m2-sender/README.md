# m2-sender — the DJ-mixer transition sender

Reads the DJ controller's own MIDI, decides **which deck is audible**, and emits a **transition** datagram to the live bridge the moment the live deck flips. This reads the DJ's _intent_ off the mixer rather than guessing from sound, so it works even for an out-of-order set — where audio fingerprinting can't tell you when a transition happened.

```
controller MIDI ──▶ sender.py (shim) ──▶ livedeck.py (pure logic) ──▶ UDP {"type":"transition","deck":N}
```

> [!WARNING]
> **The MIDI hardware path is UNVERIFIED in this slice.** The controller was **not present** when this was written. The pure decision logic (`livedeck.py`) is fully unit-tested; the MIDI I/O shim (`sender.py`) is **not** — its network path is verified end-to-end over a loopback socket, but reading the real controller has not been exercised on hardware. **Validate at the rig before trusting it live.** The control map, deck→channel mapping, and the live-deck heuristic below were validated live at the office on the real controller; the code that consumes them here has not been run against it.

## Which machine it runs on

The **mixing machine** — the one physically wired to the DJ controller and running the DJ software. The controller is class-compliant and keeps streaming MIDI to a second app _while_ the DJ software drives it, so this sender reads the same stream without stealing it. (In the two-machine rig this is the mixing Mac; the VJ/bridge runs on the streaming machine. See [`docs/live-show-setup.md`](../../../../docs/live-show-setup.md).)

## Files

| File               | What it is                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `livedeck.py`      | **Pure logic** — `audible()`, the argmax live-deck selection, the floor/margin/debounce/sticky-hold state machine. No MIDI, no network, no clock (time is injected). Fully unit-testable without hardware. |
| `sender.py`        | Thin MIDI I/O + UDP shim around `livedeck.py`. Opens the controller port, folds control-changes into per-deck state, sends the transition datagram.                                                        |
| `test_livedeck.py` | Unit tests for the pure logic, driven by synthetic CC streams.                                                                                                                                             |

## The control map (validated on the real DDJ-FLX4)

- **Deck = MIDI channel:** channel `0` = Deck 1, channel `1` = Deck 2.
- **Per-deck controls (CC numbers, on the deck's channel):** TRIM=`4`, HIGH=`7`, MID=`11`, LOW=`15`, channel fader=`19`.
- **Crossfader:** CC `31` on channel `6`.
- All of these are **14-bit** (MSB, with the LSB riding on CC+32). We read the **MSB only** — the +32 LSB CCs are ignored.
- Control values are `0` = full cut, `~64` = neutral, `127` = boost.

## The live-deck heuristic

```
audible(d) = fader[d]/127 * min(1, low[d]/35) * crossfader_gain(d)
live deck  = argmax over decks of audible(d)
```

subject to, in `livedeck.py`:

- **floor `0.12`** — the leader must clear this to be live at all (both faders down ⇒ no acquisition);
- **runner-up margin `0.15`** — the leader must beat the runner-up by this to take over;
- **debounce `0.3s`** — a challenger must stay the clear winner this long before it commits;
- **sticky-hold** — when both decks are full up the margin gate ties, so the incumbent is held (no flapping).

A committed change of live deck **is** a transition. Acquiring the first deck from cold (nothing → Deck 1) also counts as a transition.

`crossfader_gain` is linear across the FLX4 topology (Deck 1 = left, Deck 2 = right): `xfader=0` ⇒ full Deck 1, `127` ⇒ full Deck 2, `64` (centre, the resting default until a real crossfader message arrives) ⇒ both at ~0.5. Untouched EQ/faders rest at neutral (`64`), which is `≥ 35`, so a resting EQ does not pull audibility down — only a deliberate bass cut does.

## The UDP contract it emits

On each committed flip, one UDP datagram of JSON to `FLUNCLE_VJ_HOST:FLUNCLE_VJ_PORT`:

```json
{ "type": "transition", "deck": 2 }
```

`deck` is the human deck number (`1` or `2`). With `--identity-cmd`, the command's JSON stdout is attached additively:

```json
{
  "type": "transition",
  "deck": 2,
  "identity": { "title": "…", "artist": "…", "bpm": 173, "key": "5A" }
}
```

**A `{deck}` placeholder** in `--identity-cmd` is substituted with the live deck number, so the operator passes `--identity-cmd 'deckwatch.py --once --deck {deck}'` and reads only the deck that flipped. The identity is **pre-read the moment a deck becomes the debounce candidate** (before the flip commits) and cached, so the OCR round-trip is off the critical path when the transition is sent. If the pre-read is missing/stale/failed the sender falls back to reading at commit; if that fails too the transition is still sent — just without the `identity` key. **Identity failure never suppresses a transition.**

## Environment

| Variable          | Required | Default | Meaning                        |
| ----------------- | -------- | ------- | ------------------------------ |
| `FLUNCLE_VJ_HOST` | **yes**  | —       | VJ/bridge host to send UDP to. |
| `FLUNCLE_VJ_PORT` | no       | `9000`  | VJ/bridge UDP port.            |

Host and port are read from the environment **only** — never hardcoded. The sender **exits 1 with a clear error if `FLUNCLE_VJ_HOST` is unset**. (This repo is public; the VJ address is topology and must not live in source.)

## Running it

Proven stack: `mido` + `python-rtmidi` under `uv` (PEP 723 inline deps are declared in `sender.py`, so `uv` installs them on demand):

```bash
FLUNCLE_VJ_HOST=<vj-host> FLUNCLE_VJ_PORT=9000 \
  UV_CACHE_DIR=/tmp/uv-cache uv run --with mido --with python-rtmidi \
  packages/live/scripts/m2-sender/sender.py
```

Flags:

- `--port-substr <str>` — substring identifying the controller MIDI port (default `DDJ-FLX4`).
- `--identity-cmd <cmd>` — optional shell command whose JSON stdout is attached to each transition (a `{deck}` placeholder → the live deck number; pre-read on the debounce candidate and cached). Fully decoupled: the sender imports **no** deck/OCR module, so it treats the command's stdout as opaque JSON.

## Testing the pure logic

```bash
UV_CACHE_DIR=/tmp/uv-cache uv run --with "pytest==8.*" \
  pytest packages/live/scripts/m2-sender/test_livedeck.py -q
```

Pin `pytest==8.*`: the current `uv` fails to resolve a runnable entrypoint for pytest 9.x (`Failed to get entrypoints for pytest`), unrelated to these tests.

The tests drive synthetic CC streams and cover: a clean A→B transition flips exactly once; a fader wiggle below the margin does not flip; both decks full holds the incumbent; the debounce suppresses a flip-flop; a low-EQ kill on the incumbent flips even at full fader; plus below-floor non-acquisition, time-not-repetition debounce, and a crossfader slam.

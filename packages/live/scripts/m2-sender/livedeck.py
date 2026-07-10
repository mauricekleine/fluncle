# /// script
# requires-python = ">=3.10"
# ///
"""Pure live-deck logic for the DJ-mixer sender — NO MIDI, NO network.

This module is deliberately hardware-free so the whole decision layer can be
unit-tested without a controller or a socket. It owns exactly one job: given the
current mixer control values, decide WHICH deck is audible and detect the moment
the live deck flips (a transition).

The numbers here were validated live against the real DDJ-FLX4 at the office (it
flipped exactly at the bass swap of a real mix). See README.md for the map.

Deck numbering (matches the controller's MIDI channels):
    MIDI channel 0 -> Deck 1        MIDI channel 1 -> Deck 2
We work in *deck numbers* (1, 2) throughout; the MIDI shim maps channel+1.

The live-deck heuristic:
    audible(d) = fader[d]/127 * min(1, low[d]/LOW_FULL) * crossfader_gain(d)
    live deck  = argmax of audible(d), subject to:
        - an absolute floor (leader must clear FLOOR to be live at all),
        - a runner-up margin (leader must beat the runner-up by MARGIN),
        - a debounce (a candidate must hold for DEBOUNCE_S before it commits).
    When both decks are full up the margin gate ties, so the incumbent is
    sticky-held (we never flap between two decks that are both fully audible).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# ── Validated constants ────────────────────────────────────────────────────

#: MIDI control values are 7-bit MSB (we read the MSB only): 0 = full cut,
#: ~64 = neutral, 127 = boost.
MIDI_MAX = 127

#: Bass level at/above which a deck's low band counts as "fully present". Below
#: this the deck's audibility scales down linearly (a bass kill pulls it to 0).
#: Tuned against a real mix — the flip landed exactly on the bass swap.
LOW_FULL = 35

#: The FLX4 crossfader topology: Deck 1 sits on the left, Deck 2 on the right.
DECK_LEFT = 1
DECK_RIGHT = 2

# ── Selection defaults (validated) ─────────────────────────────────────────

#: Leader must clear this absolute audibility to be considered live at all.
DEFAULT_FLOOR = 0.12
#: Leader must beat the runner-up by at least this to take over (else: hold).
DEFAULT_MARGIN = 0.15
#: A new candidate must stay the clear winner this long before it commits.
DEFAULT_DEBOUNCE_S = 0.3

#: Neutral EQ / trim resting value. An untouched EQ knob sits at ~centre, which
#: is >= LOW_FULL, so it does not pull audibility down until the DJ cuts it.
NEUTRAL = 64
#: Crossfader resting value. Centre is the least-biased default until we see a
#: real crossfader message: both decks get equal crossfader gain.
CROSSFADER_CENTRE = 64


def clamp(value: float, low: float, high: float) -> float:
    """Clamp value into [low, high]."""
    return max(low, min(high, value))


@dataclass
class DeckControls:
    """The mixer control values for a single deck (7-bit MSB, 0..127).

    Only ``fader`` and ``low`` feed the audibility heuristic; ``trim``/``high``/
    ``mid`` are tracked so the shim can log a full picture and so the model can
    grow without touching the wire format.
    """

    fader: int = 0
    low: int = NEUTRAL
    mid: int = NEUTRAL
    high: int = NEUTRAL
    trim: int = NEUTRAL


def crossfader_gain(deck: int, xfader: int) -> float:
    """Linear crossfader gain for a deck given the crossfader value (0..127).

    xfader=0   -> full Deck 1 (left), Deck 2 muted.
    xfader=127 -> full Deck 2 (right), Deck 1 muted.
    xfader=64  -> both decks at ~0.5 (centre, the resting default).
    """
    t = clamp(xfader / MIDI_MAX, 0.0, 1.0)
    if deck == DECK_LEFT:
        return 1.0 - t
    if deck == DECK_RIGHT:
        return t
    # Unknown deck id: no crossfader assignment, treat as fully open.
    return 1.0


def audible(fader: int, low: int, xf_gain: float) -> float:
    """Audibility of a deck in [0, 1].

    audible = fader/127 * min(1, low/LOW_FULL) * crossfader_gain
    """
    fader_gain = clamp(fader / MIDI_MAX, 0.0, 1.0)
    bass = min(1.0, max(0.0, low) / LOW_FULL)
    return fader_gain * bass * clamp(xf_gain, 0.0, 1.0)


@dataclass
class LiveDeckSelector:
    """Stateful live-deck picker with floor / margin / debounce / sticky-hold.

    Feed it the current controls with :meth:`update`; it returns the deck number
    when a transition COMMITS on that call, and ``None`` otherwise. The committed
    live deck is also available as :attr:`live`.
    """

    floor: float = DEFAULT_FLOOR
    margin: float = DEFAULT_MARGIN
    debounce_s: float = DEFAULT_DEBOUNCE_S

    live: Optional[int] = field(default=None, init=False)
    _pending: Optional[int] = field(default=None, init=False)
    _pending_since: Optional[float] = field(default=None, init=False)

    def _clear_pending(self) -> None:
        self._pending = None
        self._pending_since = None

    def scores(self, decks: dict[int, DeckControls], xfader: int) -> dict[int, float]:
        """Audibility score per deck — pure, side-effect free (handy for logs)."""
        return {
            deck: audible(dc.fader, dc.low, crossfader_gain(deck, xfader))
            for deck, dc in decks.items()
        }

    def update(
        self,
        decks: dict[int, DeckControls],
        xfader: int,
        now: float,
    ) -> Optional[int]:
        """Advance the state machine.

        ``now`` is a monotonic timestamp in seconds (injected so tests are
        deterministic — the module never reads a clock itself). Returns the deck
        number if a transition committed on this call, else ``None``.
        """
        if not decks:
            return None

        scores = self.scores(decks, xfader)

        # Leader and runner-up.
        leader = max(scores, key=lambda d: scores[d])
        leader_score = scores[leader]
        runner_score = max(
            (s for d, s in scores.items() if d != leader),
            default=0.0,
        )

        # Gate: leader must clear the floor AND beat the runner-up by the margin.
        # A tie (both decks full up) fails the margin gate -> sticky-hold.
        qualifies = (
            leader_score >= self.floor
            and (leader_score - runner_score) >= self.margin
        )
        if not qualifies:
            self._clear_pending()
            return None

        if leader == self.live:
            # Incumbent still the clear winner — nothing to do.
            self._clear_pending()
            return None

        # A challenger clears the gate. Debounce before committing.
        if self._pending != leader or self._pending_since is None:
            self._pending = leader
            self._pending_since = now
            return None

        if now - self._pending_since >= self.debounce_s:
            self.live = leader
            self._clear_pending()
            return leader

        return None

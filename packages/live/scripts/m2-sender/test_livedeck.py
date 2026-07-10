# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=8"]
# ///
"""Unit tests for the pure live-deck logic — no MIDI, no network, no clock.

Run:  UV_CACHE_DIR=/tmp/uv-cache uv run --with pytest pytest \
        packages/live/scripts/m2-sender/test_livedeck.py

Every test drives a synthetic CC stream: we hand the selector deck controls plus
an injected monotonic ``now`` and assert on the committed transitions. The module
is imported by path so the tests never depend on mido / python-rtmidi.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "livedeck", Path(__file__).with_name("livedeck.py")
)
assert _spec and _spec.loader
ld = importlib.util.module_from_spec(_spec)
sys.modules["livedeck"] = ld
_spec.loader.exec_module(ld)

DeckControls = ld.DeckControls
LiveDeckSelector = ld.LiveDeckSelector
CROSSFADER_CENTRE = ld.CROSSFADER_CENTRE
select_cached_identity = ld.select_cached_identity


def decks(
    d1_fader: int = 0,
    d1_low: int = 64,
    d2_fader: int = 0,
    d2_low: int = 64,
) -> dict[int, "ld.DeckControls"]:
    """Two-deck snapshot; EQ defaults to neutral (present)."""
    return {
        1: DeckControls(fader=d1_fader, low=d1_low),
        2: DeckControls(fader=d2_fader, low=d2_low),
    }


def drive(selector, snapshot, xfader, start, *, steps=20, dt=0.05):
    """Feed the same snapshot repeatedly over time, collecting committed decks.

    Returns the list of decks that committed a transition across the run.
    """
    committed = []
    t = start
    for _ in range(steps):
        got = selector.update(snapshot, xfader, now=t)
        if got is not None:
            committed.append(got)
        t += dt
    return committed


# ── audible() sanity ────────────────────────────────────────────────────────


def test_audible_full_fader_full_bass_full_crossfader_is_one():
    assert ld.audible(127, 127, 1.0) == pytest.approx(1.0, abs=1e-6)


def test_audible_bass_kill_zeroes_the_deck():
    # low = 0 -> min(1, 0/35) = 0 -> silent regardless of fader.
    assert ld.audible(127, 0, 1.0) == 0.0


def test_audible_fader_down_zeroes_the_deck():
    assert ld.audible(0, 127, 1.0) == 0.0


def test_crossfader_gain_endpoints():
    assert ld.crossfader_gain(1, 0) == pytest.approx(1.0)
    assert ld.crossfader_gain(2, 0) == pytest.approx(0.0)
    assert ld.crossfader_gain(1, 127) == pytest.approx(0.0)
    assert ld.crossfader_gain(2, 127) == pytest.approx(1.0)
    # Centre: both decks ~half.
    assert ld.crossfader_gain(1, CROSSFADER_CENTRE) == pytest.approx(0.5, abs=0.01)
    assert ld.crossfader_gain(2, CROSSFADER_CENTRE) == pytest.approx(0.5, abs=0.01)


# ── the five required behaviours ────────────────────────────────────────────


def test_clean_A_to_B_flips_live_deck_exactly_once():
    """Deck 1 up, then a clean swap to Deck 2 -> Deck 2 commits exactly once."""
    sel = LiveDeckSelector()
    xf = CROSSFADER_CENTRE

    # Acquire Deck 1 (this is itself one transition: nothing -> Deck 1).
    got = drive(sel, decks(d1_fader=127, d1_low=127), xf, start=0.0)
    assert got == [1]
    assert sel.live == 1

    # Clean transition: Deck 2 comes fully up, Deck 1 pulled down.
    got = drive(sel, decks(d1_fader=0, d2_fader=127, d2_low=127), xf, start=1.0)
    assert got == [2]  # exactly once
    assert sel.live == 2


def test_fader_wiggle_below_margin_does_not_flip():
    """A small Deck 2 nudge that never clears the runner-up margin holds Deck 1."""
    sel = LiveDeckSelector()
    xf = CROSSFADER_CENTRE

    drive(sel, decks(d1_fader=127, d1_low=127), xf, start=0.0)
    assert sel.live == 1

    # Deck 1 full, Deck 2 barely up (fader ~30/127 ≈ 0.12 audible) — the gap to
    # Deck 1 stays well above the 0.15 margin, and Deck 2 never leads anyway.
    got = drive(sel, decks(d1_fader=127, d1_low=127, d2_fader=30), xf, start=1.0)
    assert got == []
    assert sel.live == 1


def test_both_decks_full_holds_the_incumbent():
    """Both decks fully up -> margin ties -> sticky-hold Deck 1, no flip."""
    sel = LiveDeckSelector()
    xf = CROSSFADER_CENTRE

    drive(sel, decks(d1_fader=127, d1_low=127), xf, start=0.0)
    assert sel.live == 1

    got = drive(
        sel,
        decks(d1_fader=127, d1_low=127, d2_fader=127, d2_low=127),
        xf,
        start=1.0,
    )
    assert got == []
    assert sel.live == 1


def test_debounce_suppresses_a_flip_flop():
    """A challenger that appears then vanishes inside the debounce never commits."""
    sel = LiveDeckSelector()
    xf = CROSSFADER_CENTRE

    drive(sel, decks(d1_fader=127, d1_low=127), xf, start=0.0)
    assert sel.live == 1

    # t=1.00: Deck 2 leads (Deck 1 bass killed) -> becomes pending.
    assert sel.update(decks(d1_fader=127, d1_low=0, d2_fader=127, d2_low=127), xf, now=1.00) is None
    # t=1.10: still inside the 0.3s debounce -> not committed yet.
    assert sel.update(decks(d1_fader=127, d1_low=0, d2_fader=127, d2_low=127), xf, now=1.10) is None
    # t=1.20: Deck 1 bass returns, both full again -> challenger vanishes, pending cleared.
    assert sel.update(decks(d1_fader=127, d1_low=127, d2_fader=127, d2_low=127), xf, now=1.20) is None
    # t=1.60: well past the original debounce window, but the flip-flop was cancelled.
    assert sel.update(decks(d1_fader=127, d1_low=127, d2_fader=127, d2_low=127), xf, now=1.60) is None

    assert sel.live == 1


def test_low_eq_kill_on_incumbent_flips_even_at_full_fader():
    """Both decks at full fader; killing the incumbent's bass flips to the other."""
    sel = LiveDeckSelector()
    xf = CROSSFADER_CENTRE

    # Both up -> Deck 1 held incumbent.
    drive(sel, decks(d1_fader=127, d1_low=127), xf, start=0.0)
    both_full = decks(d1_fader=127, d1_low=127, d2_fader=127, d2_low=127)
    drive(sel, both_full, xf, start=1.0)
    assert sel.live == 1

    # Kill Deck 1's LOW while its fader stays full -> Deck 2 becomes audible.
    killed = decks(d1_fader=127, d1_low=0, d2_fader=127, d2_low=127)
    got = drive(sel, killed, xf, start=2.0)
    assert got == [2]
    assert sel.live == 2


# ── selection edge cases ─────────────────────────────────────────────────────


def test_below_floor_never_acquires_a_deck():
    """Faders barely cracked open -> nothing clears the floor -> no live deck."""
    sel = LiveDeckSelector()
    got = drive(sel, decks(d1_fader=10, d1_low=64), CROSSFADER_CENTRE, start=0.0)
    assert got == []
    assert sel.live is None


def test_debounce_requires_time_not_just_repetition():
    """Same instant, many calls -> no commit until the debounce interval elapses."""
    sel = LiveDeckSelector()
    snap = decks(d1_fader=127, d1_low=127)
    xf = CROSSFADER_CENTRE
    # Ten calls all at t=0 -> pending set but never ages past debounce.
    for _ in range(10):
        assert sel.update(snap, xf, now=0.0) is None
    assert sel.live is None
    # Now let 0.3s pass in one step -> commits.
    assert sel.update(snap, xf, now=0.3) == 1
    assert sel.live == 1


def test_crossfader_slam_swaps_the_live_deck():
    """Both decks up; slamming the crossfader to Deck 2's side flips the live deck."""
    sel = LiveDeckSelector()
    both = decks(d1_fader=127, d1_low=127, d2_fader=127, d2_low=127)

    # Crossfader hard left -> Deck 1.
    got = drive(sel, both, 0, start=0.0)
    assert got == [1]

    # Crossfader hard right -> Deck 2.
    got = drive(sel, both, 127, start=1.0)
    assert got == [2]


# ── the pending accessor (the pre-read trigger) ──────────────────────────────


def test_pending_exposes_the_debounce_candidate_before_commit():
    """A challenger in the debounce window is visible as `pending` BEFORE it commits."""
    sel = LiveDeckSelector()
    xf = CROSSFADER_CENTRE

    # Acquire Deck 1 cold.
    assert sel.update(decks(d1_fader=127, d1_low=127), xf, now=0.0) is None
    assert sel.pending == 1  # Deck 1 is the debounce candidate...
    assert sel.update(decks(d1_fader=127, d1_low=127), xf, now=0.3) == 1  # ...then commits
    assert sel.pending is None  # cleared on commit

    # Now a clean challenger: Deck 2 up, Deck 1 down. It becomes pending, then commits.
    swap = decks(d1_fader=0, d2_fader=127, d2_low=127)
    assert sel.update(swap, xf, now=1.0) is None
    assert sel.pending == 2  # the pre-read fires HERE, off the critical path
    assert sel.update(swap, xf, now=1.4) == 2
    assert sel.pending is None


def test_pending_clears_when_a_flipflop_challenger_vanishes():
    """A challenger that disappears inside the debounce clears `pending` (no stale pre-read)."""
    sel = LiveDeckSelector()
    xf = CROSSFADER_CENTRE
    sel.update(decks(d1_fader=127, d1_low=127), xf, now=0.0)
    sel.update(decks(d1_fader=127, d1_low=127), xf, now=0.3)  # commit Deck 1
    # Deck 2 challenges (Deck 1 bass killed) -> pending 2.
    sel.update(decks(d1_fader=127, d1_low=0, d2_fader=127, d2_low=127), xf, now=1.0)
    assert sel.pending == 2
    # Deck 1 bass returns before the debounce elapses -> challenger gone, pending cleared.
    sel.update(decks(d1_fader=127, d1_low=127, d2_fader=127, d2_low=127), xf, now=1.1)
    assert sel.pending is None
    assert sel.live == 1


# ── select_cached_identity (the pre-read cache, pure) ────────────────────────


def test_cached_identity_fresh_hit_is_returned():
    ident = {"deck": 2, "title": "Strength", "artist": "Technimatic"}
    cache = {2: (ident, 100.0)}
    assert select_cached_identity(cache, 2, now=101.0, max_age_s=5.0) is ident


def test_cached_identity_miss_returns_none():
    assert select_cached_identity({}, 1, now=0.0, max_age_s=5.0) is None
    # A read for a different deck is a miss (each deck caches independently).
    assert select_cached_identity({2: ({}, 0.0)}, 1, now=0.0, max_age_s=5.0) is None


def test_cached_identity_stale_read_falls_back_to_none():
    cache = {1: ({"title": "old"}, 100.0)}
    # 6s old with a 5s ceiling -> stale -> None (the caller re-reads at commit).
    assert select_cached_identity(cache, 1, now=106.0, max_age_s=5.0) is None
    # Exactly at the boundary is still fresh.
    assert select_cached_identity(cache, 1, now=105.0, max_age_s=5.0) is not None


def test_cached_identity_default_max_age_is_used():
    ident = {"title": "t"}
    cache = {1: (ident, 0.0)}
    # DEFAULT_PREREAD_MAX_AGE_S applies when max_age_s is omitted.
    assert select_cached_identity(cache, 1, now=ld.DEFAULT_PREREAD_MAX_AGE_S) is ident
    assert select_cached_identity(cache, 1, now=ld.DEFAULT_PREREAD_MAX_AGE_S + 0.1) is None

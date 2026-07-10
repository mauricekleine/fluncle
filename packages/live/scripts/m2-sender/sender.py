# /// script
# requires-python = ">=3.10"
# dependencies = ["mido>=1.3", "python-rtmidi>=1.5"]
# ///
"""DJ-mixer sender: read the controller's MIDI, decide the live deck, emit a
transition datagram to the live bridge.

This is the thin hardware/network shim around the pure logic in ``livedeck.py``.
It opens the class-compliant DDJ-FLX4 MIDI input (the controller keeps streaming
to a second app while the DJ software drives it), folds each control-change into
per-deck state, and asks the selector whether the live deck just flipped. On a
flip it sends one UDP datagram of JSON to the VJ host.

Run (on the mixing machine, alongside the DJ software):

    FLUNCLE_VJ_HOST=<vj-host> FLUNCLE_VJ_PORT=9000 \
      UV_CACHE_DIR=/tmp/uv-cache uv run --with mido --with python-rtmidi \
      packages/live/scripts/m2-sender/sender.py

Host and port come from the environment ONLY — never hardcoded. The script exits
loudly if FLUNCLE_VJ_HOST is unset. See README.md.

⚠ The MIDI hardware path in this file is UNVERIFIED — the controller was not
present when it was written. The pure logic (livedeck.py) is unit-tested; this
shim is not. Validate at the rig before trusting it live.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from typing import Optional

from livedeck import (
    CROSSFADER_CENTRE,
    DeckControls,
    LiveDeckSelector,
)

# ── Validated control map (7-bit MSB CC numbers) ───────────────────────────
# All EQ/fader controls are 14-bit: the LSB rides on CC+32. We read the MSB
# only, so we simply never match the +32 LSB CCs.
CC_TRIM = 4
CC_HIGH = 7
CC_MID = 11
CC_LOW = 15
CC_FADER = 19

#: Deck = MIDI channel: channel 0 -> Deck 1, channel 1 -> Deck 2.
DECK_CHANNELS = {0: 1, 1: 2}

#: Crossfader lives on its own channel/CC.
CROSSFADER_CHANNEL = 6
CROSSFADER_CC = 31

#: Substring that identifies the controller's MIDI port.
DEFAULT_PORT_SUBSTR = "DDJ-FLX4"

#: Default VJ port when FLUNCLE_VJ_PORT is unset.
DEFAULT_VJ_PORT = 9000


def eprint(*args: object) -> None:
    """Log to stderr (stdout stays clean)."""
    print(*args, file=sys.stderr, flush=True)


def resolve_target() -> tuple[str, int]:
    """Read the VJ host/port from the environment. Exit loudly if host is unset."""
    host = os.environ.get("FLUNCLE_VJ_HOST", "").strip()
    if not host:
        eprint(
            "FATAL: FLUNCLE_VJ_HOST is not set. The sender never hardcodes the "
            "VJ address — export FLUNCLE_VJ_HOST (and optionally FLUNCLE_VJ_PORT, "
            f"default {DEFAULT_VJ_PORT}) and re-run."
        )
        sys.exit(1)

    raw_port = os.environ.get("FLUNCLE_VJ_PORT", "").strip()
    if not raw_port:
        return host, DEFAULT_VJ_PORT
    try:
        port = int(raw_port)
    except ValueError:
        eprint(f"FATAL: FLUNCLE_VJ_PORT is not an integer: {raw_port!r}")
        sys.exit(1)
    if not (0 < port < 65536):
        eprint(f"FATAL: FLUNCLE_VJ_PORT out of range: {port}")
        sys.exit(1)
    return host, port


def fetch_identity(identity_cmd: Optional[str]) -> Optional[object]:
    """Run an arbitrary identity command and parse its stdout as JSON.

    Fully decoupled by design: this shells out to whatever command the operator
    passes and treats its stdout as opaque JSON. It imports NO deck/OCR module —
    a sibling PR owns that and may not be merged. On any failure we log and drop
    identity (a transition still goes out; identity is additive).
    """
    if not identity_cmd:
        return None
    try:
        proc = subprocess.run(
            identity_cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        eprint("warn: --identity-cmd timed out; sending transition without identity")
        return None
    if proc.returncode != 0:
        eprint(
            f"warn: --identity-cmd exited {proc.returncode}; "
            f"sending transition without identity: {proc.stderr.strip()[:200]}"
        )
        return None
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        eprint(f"warn: --identity-cmd stdout was not JSON ({exc}); dropping identity")
        return None


def send_transition(
    sock: socket.socket,
    host: str,
    port: int,
    deck: int,
    identity_cmd: Optional[str],
) -> None:
    """Emit one UDP datagram: {"type":"transition","deck":N[,"identity":…]}."""
    packet: dict[str, object] = {"type": "transition", "deck": deck}
    identity = fetch_identity(identity_cmd)
    if identity is not None:
        packet["identity"] = identity
    payload = json.dumps(packet).encode("utf-8")
    sock.sendto(payload, (host, port))
    eprint(f"transition -> deck {deck}  ({host}:{port})")


def open_input(port_substr: str):
    """Open the first MIDI input whose name contains ``port_substr``.

    Imported lazily so ``resolve_target`` / arg parsing (and any --help) work
    without the MIDI backend present.
    """
    import mido  # noqa: PLC0415 — lazy so the module imports without a backend

    names = mido.get_input_names()
    match = next((n for n in names if port_substr in n), None)
    if match is None:
        eprint(
            f"FATAL: no MIDI input matching {port_substr!r}. Available inputs: "
            f"{names or '(none)'}. Is the controller connected and the DJ "
            "software running?"
        )
        sys.exit(1)
    eprint(f"listening on MIDI input: {match}")
    return mido.open_input(match)


def run(port_substr: str, identity_cmd: Optional[str]) -> None:
    host, port = resolve_target()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    selector = LiveDeckSelector()
    decks = {1: DeckControls(), 2: DeckControls()}
    xfader = CROSSFADER_CENTRE

    inport = open_input(port_substr)
    eprint(f"sending transitions to {host}:{port}")

    for msg in inport:
        if msg.type != "control_change":
            continue

        channel, control, value = msg.channel, msg.control, msg.value

        if channel == CROSSFADER_CHANNEL and control == CROSSFADER_CC:
            xfader = value
        elif channel in DECK_CHANNELS:
            deck = decks[DECK_CHANNELS[channel]]
            if control == CC_FADER:
                deck.fader = value
            elif control == CC_LOW:
                deck.low = value
            elif control == CC_MID:
                deck.mid = value
            elif control == CC_HIGH:
                deck.high = value
            elif control == CC_TRIM:
                deck.trim = value
            else:
                continue  # LSB (CC+32) or an unmapped control — ignore.
        else:
            continue

        committed = selector.update(decks, xfader, now=time.monotonic())
        if committed is not None:
            send_transition(sock, host, port, committed, identity_cmd)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Read the DJ mixer's MIDI, detect the live deck, and emit a UDP "
            "transition to the live bridge. VJ host/port come from "
            "FLUNCLE_VJ_HOST / FLUNCLE_VJ_PORT."
        )
    )
    parser.add_argument(
        "--port-substr",
        default=DEFAULT_PORT_SUBSTR,
        help=f"substring identifying the controller MIDI port (default: {DEFAULT_PORT_SUBSTR})",
    )
    parser.add_argument(
        "--identity-cmd",
        default=None,
        help=(
            "optional shell command whose JSON stdout is attached to each "
            "transition packet under 'identity'. Fully decoupled — the sender "
            "imports no deck/OCR module."
        ),
    )
    args = parser.parse_args()

    try:
        run(args.port_substr, args.identity_cmd)
    except KeyboardInterrupt:
        eprint("\nstopped.")


if __name__ == "__main__":
    main()

"""The Galaxy intro break — a first-party 8-bit amen breakbeat, DRUMS ONLY (no
synths). Synthesized from scratch (no sample), so it is clearance-clean (the
sanctioned "Fluncle-made breakbeat that evokes the amen" option). Kick, snare,
ghost snares, hats, an opening crash — the percussion kit, matching the game's
SFX voices.

~6.4s at 174 BPM: the amen groove (the syncopated snare + ghost pattern, with
the second-bar lean) over a 2-bar cycle, twice. stdlib only → WAV; ffmpeg → mp3.

    UV_CACHE_DIR=/tmp/uv-cache uv run python packages/media/scripts/generate-amen.py
    ffmpeg -y -i /tmp/amen.wav -ac 1 -b:a 96k apps/web/public/galaxy/amen.mp3
"""

import math
import random
import struct
import wave

SR = 22050
BPM = 174.0
SIXTEENTH = (60.0 / BPM) / 4.0
STEP = int(SR * SIXTEENTH)
BARS = 4
STEPS = 16 * BARS
TOTAL = STEP * STEPS + int(SR * 0.9)  # tail for the last decay

random.seed(1969)  # the Amen, Brother year — for the record
buf = [0.0] * TOTAL


def add(start, samples):
    for i, s in enumerate(samples):
        j = start + i
        if 0 <= j < TOTAL:
            buf[j] += s


def kick(dur=0.30):
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        # Punchy click → sub tail (the D&B kick has weight).
        freq = 48 + 110 * math.exp(-t * 26)
        out.append(math.sin(2 * math.pi * freq * t) * math.exp(-t * 8) * 0.95)
    return out


def snare(dur=0.20, gain=0.7):
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        noise = (random.random() * 2 - 1) * math.exp(-t * 26)
        body = math.sin(2 * math.pi * 190 * t) * math.exp(-t * 20)
        crack = math.sin(2 * math.pi * 330 * t) * math.exp(-t * 30)
        out.append((noise * 0.8 + body * 0.4 + crack * 0.2) * gain)
    return out


def hat(dur=0.045, gain=0.22):
    n = int(SR * dur)
    return [(random.random() * 2 - 1) * math.exp(-(i / SR) * 80) * gain for i in range(n)]


def crash(dur=0.7, gain=0.22):
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        shimmer = 1 + 0.3 * math.sin(2 * math.pi * 60 * t)
        out.append((random.random() * 2 - 1) * math.exp(-t * 4) * shimmer * gain)
    return out


# The amen groove on a 2-bar (32-step) cycle: backbeat snares on 4/12, the
# kick syncopation, ghost-snare rolls, and the second bar's late-snare lean.
kick_steps = {0, 10, 16, 19, 26}
snare_steps = {4, 12, 20, 28, 31}
ghost_steps = {7, 14, 23, 30}
hat_steps = {s for s in range(32) if s % 2 == 0} | {5, 11, 21, 27}

for step in range(STEPS):
    at = step * STEP
    cyc = step % 32
    if step == 0:
        add(at, crash())
    if cyc in hat_steps:
        add(at, hat())
    if cyc in kick_steps:
        add(at, kick())
    if cyc in snare_steps:
        add(at, snare())
    if cyc in ghost_steps:
        add(at, snare(dur=0.11, gain=0.26))

peak = max(1e-6, max(abs(s) for s in buf))
scale = 0.92 / peak
frames = b"".join(struct.pack("<h", int(max(-1, min(1, s * scale)) * 32767)) for s in buf)

with wave.open("/tmp/amen.wav", "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(frames)

print("wrote /tmp/amen.wav", round(TOTAL / SR, 2), "s")

#!/usr/bin/env python3
# embed-track.py — MuQ audio embedding for the `fluncle-embed` sweep (host timer).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). Invoked ONCE per tick by the bun orchestrator
# (embed-sweep.ts) with a manifest of already-downloaded CAPTURED FULL SONGS (S3-GET from the
# private fluncle-source-audio bucket), so the (multi-second) MuQ model load is amortized
# across the batch.
#
# Contract (stdin → stdout, both JSON, nothing else on stdout) — UNCHANGED:
#   stdin : [{"id": "<trackId>", "path": "/abs/full-song.<ext>"}, ...]
#   stdout: {"results": [{"id": "<trackId>", "embedding": [<1024 floats>]}],
#            "errors":  [{"id": "<trackId>", "error": "<message>"}]}
# Diagnostics go to stderr; a per-item decode/inference failure is captured in
# `errors` (that finding stays queued) and never aborts the batch.
#
# The model + pooling are the RFC's decided pipeline (docs/rfcs/full-audio-rfc.md § Unit 3):
# `OpenMuQ/MuQ-large-msd-iter`, mean-pool `last_hidden_state` over time → 1024-d, L2-normalize.
# MuQ wants 24 kHz mono, so we decode each file with ffmpeg (present in the container) to
# 24 kHz mono float32 PCM — no librosa/torchaudio codec path.
#
# WHY WINDOWING (the Unit 3 change): the source is now the FULL SONG (minutes), not a 30s
# preview. A single MuQ forward over ~5 min blows past the box's 8 GB (a 30s preview alone
# measured 2.85 GB, and the activation memory scales with the sequence length). So we chunk
# the decoded signal into fixed ~30s windows, run MuQ on ONE window at a time — freeing that
# window's activation tensors before the next forward so peak RAM is bounded by a single
# ~30s window (never the whole song) — mean-pool each window over its time axis to a 1024-d
# vector, then MEAN-POOL those per-window vectors into ONE 1024-d vector and L2-normalize.
# The output shape (1024-d, L2-normalized) is unchanged, so downstream `get_similar_findings`
# cosine is unchanged; only the decode→window→pool path differs.
#
# The torch trio (torch + torchaudio + torchvision, matched CPU builds) + muq + Python 3.11
# are baked into the Hermes image as a pinned layer; the MuQ weights are baked too (or an HF
# cache), so `from_pretrained` resolves offline. See the Dockerfile MuQ layer +
# docs/agents/hermes/embed-timer/README.md.

import json
import os
import subprocess
import sys

# MuQ's native input sample rate. Mean-pooled last_hidden_state is 1024-d.
SAMPLE_RATE = 24000
EMBEDDING_DIMS = 1024
MODEL_ID = os.environ.get("MUQ_MODEL", "OpenMuQ/MuQ-large-msd-iter")

# Windowing (bounds peak RAM to a single window's forward):
#   WINDOW_SECONDS — the length of audio fed to ONE MuQ forward. ~30s matches the memory the
#                    box already tolerated on a 30s preview (~2.85 GB); larger windows risk the
#                    8 GB ceiling, smaller windows waste forwards. Overridable for the RAM
#                    verification via MUQ_WINDOW_SECONDS.
#   HOP_SECONDS    — the step between window starts. Equal to WINDOW_SECONDS → non-overlapping
#                    windows: the fewest forwards (lowest wall-clock) for full coverage of the
#                    song. (Overlap would only smooth the mean marginally at real compute cost.)
#   MIN_TAIL_SECONDS — a trailing remainder shorter than this is dropped ONCE at least one full
#                    window was pooled (a few-second forward is noise under equal-weight mean
#                    pooling). A whole song shorter than one window is still embedded as one
#                    (possibly short) window rather than dropped.
WINDOW_SECONDS = float(os.environ.get("MUQ_WINDOW_SECONDS", "30"))
HOP_SECONDS = float(os.environ.get("MUQ_HOP_SECONDS", str(WINDOW_SECONDS)))
MIN_TAIL_SECONDS = float(os.environ.get("MUQ_MIN_TAIL_SECONDS", "10"))

WINDOW_SAMPLES = max(1, int(WINDOW_SECONDS * SAMPLE_RATE))
HOP_SAMPLES = max(1, int(HOP_SECONDS * SAMPLE_RATE))
MIN_TAIL_SAMPLES = max(1, int(MIN_TAIL_SECONDS * SAMPLE_RATE))


def log(message: str) -> None:
    print(f"[embed-track] {message}", file=sys.stderr, flush=True)


def decode_audio(path: str):
    """ffmpeg-decode an audio file to a mono 24 kHz float32 numpy array in [-1, 1]."""
    import numpy as np

    # -f f32le: raw little-endian float32 samples; -ac 1 mono; -ar 24000; to stdout.
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-i", path,
            "-f", "f32le", "-acodec", "pcm_f32le",
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-",
        ],
        capture_output=True,
        check=True,
    )
    audio = np.frombuffer(result.stdout, dtype=np.float32).copy()

    if audio.size == 0:
        raise ValueError("decoded audio is empty")

    return audio


def embed_windows(muq, torch, np, audio) -> list:
    """Window the full song into non-overlapping ~30s chunks, MuQ-forward each SEQUENTIALLY,
    mean-pool each over time, then mean-pool across windows → one L2-normalized 1024-d vector.

    Peak RAM is bounded by a SINGLE window's forward: each window's activation tensors are
    freed (`del` + the loop moving on) before the next forward, and only the running 1024-d sum
    (tiny) is carried between windows — never the whole song's hidden states."""
    total = int(audio.shape[0])

    pooled_sum = None  # running sum of per-window 1024-d vectors
    windows = 0

    for start in range(0, total, HOP_SAMPLES):
        window = audio[start:start + WINDOW_SAMPLES]

        # Drop a short trailing remainder once we already have a full window (a few-second
        # forward is noise under equal-weight pooling). A whole song shorter than one window
        # still yields one window here (windows == 0), so it is never dropped.
        if window.shape[0] < MIN_TAIL_SAMPLES and windows > 0:
            break

        wavs = torch.from_numpy(window).unsqueeze(0)  # [1, window_samples]

        with torch.inference_mode():
            output = muq(wavs, output_hidden_states=True)

        # last_hidden_state: [1, time, 1024] → mean over THIS window's time → [1024].
        pooled = output.last_hidden_state.mean(dim=1).squeeze(0).to(torch.float32)
        pooled_sum = pooled.clone() if pooled_sum is None else pooled_sum + pooled
        windows += 1

        # Free the window's activation tensors before the next forward so peak RAM stays
        # bounded by a single ~30s window, never the whole song.
        del output, pooled, wavs

    if pooled_sum is None or windows == 0:
        raise ValueError("no embeddable windows")

    # Mean-pool across windows, then L2-normalize the single 1024-d result.
    mean_pooled = pooled_sum / windows
    normalized = torch.nn.functional.normalize(mean_pooled, p=2, dim=0)
    vector = normalized.to(torch.float32).cpu().tolist()

    if len(vector) != EMBEDDING_DIMS or not all(np.isfinite(vector)):
        raise ValueError(f"expected {EMBEDDING_DIMS} finite dims, got {len(vector)}")

    return vector


def main() -> int:
    try:
        manifest = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        print(json.dumps({"error": f"bad manifest: {error}"}))
        return 1

    if not isinstance(manifest, list) or not manifest:
        print(json.dumps({"results": [], "errors": []}))
        return 0

    # Heavy imports + model load happen ONCE, after the manifest is known to be
    # non-empty (a no-op tick never pays the torch import cost).
    import numpy as np
    import torch
    from muq import MuQ

    # Use every core the box grants (CPX32 = 4) for CPU inference.
    torch.set_num_threads(max(1, os.cpu_count() or 1))

    log(f"loading {MODEL_ID}")
    muq = MuQ.from_pretrained(MODEL_ID)
    muq = muq.eval()

    results = []
    errors = []

    for item in manifest:
        track_id = item.get("id")
        path = item.get("path")

        if not track_id or not path:
            errors.append({"error": "manifest item missing id/path", "id": track_id})
            continue

        try:
            audio = decode_audio(path)
            vector = embed_windows(muq, torch, np, audio)
            results.append({"embedding": vector, "id": track_id})
            log(f"{track_id}: embedded ({len(vector)}-d)")
        except Exception as error:  # noqa: BLE001 — one bad item must not kill the batch
            errors.append({"error": str(error), "id": track_id})
            log(f"{track_id}: {error}")

    print(json.dumps({"errors": errors, "results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

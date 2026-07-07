#!/usr/bin/env python3
# embed-track.py — MuQ audio embedding for the `fluncle-embed` cron.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). Invoked ONCE per tick by the bun
# orchestrator (embed-sweep.ts) with a manifest of already-downloaded previews, so
# the (multi-second) MuQ model load is amortized across the whole batch.
#
# Contract (stdin → stdout, both JSON, nothing else on stdout):
#   stdin : [{"id": "<trackId>", "path": "/abs/preview.mp3"}, ...]
#   stdout: {"results": [{"id": "<trackId>", "embedding": [<1024 floats>]}],
#            "errors":  [{"id": "<trackId>", "error": "<message>"}]}
# Diagnostics go to stderr; a per-item decode/inference failure is captured in
# `errors` (that finding stays queued) and never aborts the batch.
#
# The model + pooling are the RFC's decided pipeline (docs/rfcs/audio-embedding-rfc.md):
# `OpenMuQ/MuQ-large-msd-iter`, mean-pool `last_hidden_state` over time → 1024-d,
# L2-normalize. MuQ wants 24 kHz mono, so we decode each preview with ffmpeg (present
# in the container) to 24 kHz mono float32 PCM — no librosa/torchaudio codec path.
#
# The torch trio (torch + torchaudio + torchvision, matched CPU builds) + muq +
# Python 3.11 are baked into the Hermes image as a pinned layer; the MuQ weights are
# baked too (or an HF cache), so `from_pretrained` resolves offline. See the Dockerfile
# MuQ layer + docs/agents/hermes/cron/README.md.

import json
import os
import subprocess
import sys

# MuQ's native input sample rate. Mean-pooled last_hidden_state is 1024-d.
SAMPLE_RATE = 24000
EMBEDDING_DIMS = 1024
MODEL_ID = os.environ.get("MUQ_MODEL", "OpenMuQ/MuQ-large-msd-iter")


def log(message: str) -> None:
    print(f"[embed-track] {message}", file=sys.stderr, flush=True)


def decode_preview(path: str):
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
            audio = decode_preview(path)
            wavs = torch.from_numpy(audio).unsqueeze(0)  # [1, samples]

            with torch.inference_mode():
                output = muq(wavs, output_hidden_states=True)

            # last_hidden_state: [1, time, 1024] → mean over time → [1024].
            pooled = output.last_hidden_state.mean(dim=1).squeeze(0)
            normalized = torch.nn.functional.normalize(pooled, p=2, dim=0)
            vector = normalized.to(torch.float32).cpu().tolist()

            if len(vector) != EMBEDDING_DIMS or not all(np.isfinite(vector)):
                raise ValueError(f"expected {EMBEDDING_DIMS} finite dims, got {len(vector)}")

            results.append({"embedding": vector, "id": track_id})
            log(f"{track_id}: embedded ({len(vector)}-d)")
        except Exception as error:  # noqa: BLE001 — one bad item must not kill the batch
            errors.append({"error": str(error), "id": track_id})
            log(f"{track_id}: {error}")

    print(json.dumps({"errors": errors, "results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash

set -euo pipefail

REPO_URL="${FLUNCLE_REPO_URL:-https://github.com/mauricekleine/fluncle.git}"
WORKDIR="${FLUNCLE_POD_WORKDIR:-/workspace/fluncle}"

export MUQ_DEVICE="${MUQ_DEVICE:-cuda}"
export MUQ_WINDOW_BATCH="${MUQ_WINDOW_BATCH:-8}"

missing=()
for var in FLUNCLE_API_TOKEN R2_ACCOUNT_ID FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY; do

	[ -n "${!var:+SET}" ] || missing+=("$var")
done

if [ "${#missing[@]}" -gt 0 ]; then
	printf 'Missing required env var(s): %s\n' "${missing[*]}" >&2
	printf 'See the header of this file, and docs/gpu-batch-embed.md.\n' >&2
	exit 1
fi

echo "==> system deps (ffmpeg for the decode path, git, curl, unzip for bun)"
if command -v apt-get >/dev/null 2>&1; then
	apt-get update -qq
	apt-get install -y -qq --no-install-recommends ffmpeg git curl unzip
fi

echo "==> bun (the orchestrator's runtime)"
if ! command -v bun >/dev/null 2>&1; then
	curl -fsSL https://bun.sh/install | bash
	export PATH="${HOME}/.bun/bin:${PATH}"
fi

echo "==> muq + its deps (torch is already in the PyTorch template — do NOT reinstall it, the"
echo "    template's build is the one matched to this pod's CUDA)"

python3 -m pip install --quiet muq "transformers==4.40.2" "numpy<2"

echo "==> preflight: torch / transformers / numpy must agree"
python3 - <<'PY'
import sys

def die(what, err):
    sys.exit(
        f"PREFLIGHT FAILED ({what}): {err}\n"
        "  The muq install resolved a dependency this image's torch cannot carry.\n"
        "  muq leaves `transformers` and `numpy` UNPINNED, so pip takes the current major of each:\n"
        "    transformers 5.x needs torch >= 2.2  -> NameError: name 'torch' is not defined\n"
        "    numpy 2.x vs a torch built on 1.x    -> Failed to initialize NumPy: _ARRAY_API not found\n"
        "  Fix the pins in this script to match the image's torch, then re-run.\n"
        "  Background: the fluncle-embed-batch skill, 'Pitfalls, collected'."
    )

try:
    import torch
except Exception as e:  # noqa: BLE001 - any import failure is fatal here
    die("importing torch", e)
try:
    import transformers
except Exception as e:  # noqa: BLE001
    die("importing transformers", e)

# A too-new transformers does NOT raise here — it quietly DISABLES its torch backend ("Disabling
# PyTorch because PyTorch >= 2.4 is required but found 2.1.0") and imports fine, so checking the
# import alone is a false green. The blow-up lands later, inside MuQ, as a bare NameError. Assert
# the backend is actually live.
if not transformers.utils.is_torch_available():
    die(
        "transformers has no torch backend",
        f"transformers {transformers.__version__} disabled torch {torch.__version__} as too old",
    )

try:
    import numpy
    # The numpy<->torch bridge is what the decode path rides on, and it is what a numpy major
    # mismatch actually breaks — importing both cleanly is NOT enough to prove it works.
    torch.from_numpy(numpy.zeros(4, dtype="float32"))
except Exception as e:  # noqa: BLE001
    die("numpy<->torch bridge", e)

# The real integration: this exact import is what died on the first run.
try:
    from muq import MuQ  # noqa: F401
except Exception as e:  # noqa: BLE001
    die("importing muq", e)

print(f"  torch {torch.__version__} · transformers {transformers.__version__} · numpy {numpy.__version__}")
print(f"  cuda available: {torch.cuda.is_available()}")
PY

echo "==> repo"
if [ -d "${WORKDIR}/.git" ]; then
	git -C "${WORKDIR}" fetch --depth 1 origin main
	git -C "${WORKDIR}" reset --hard origin/main
else
	git clone --depth 1 "${REPO_URL}" "${WORKDIR}"
fi

echo "==> warming the MuQ weights + one forward (a first from_pretrained downloads ~1 GB; do it"
echo "    once, before the batch, so a slow HF pull is not billed as GPU time inside the run)"

python3 - <<'PY'
import torch
from muq import MuQ
muq = MuQ.from_pretrained("OpenMuQ/MuQ-large-msd-iter").eval()
with torch.inference_mode():
    hidden = muq(torch.zeros(1, 24000), output_hidden_states=True).last_hidden_state
assert hidden.shape[-1] == 1024, tuple(hidden.shape)
print(f"MuQ weights cached; forward ok {tuple(hidden.shape)}")
PY

echo "==> batch (device=${MUQ_DEVICE}, window batch=${MUQ_WINDOW_BATCH})"
echo "    the run is bounded by the CLOCK — pass --minutes to match the block you rented"
exec bun "${WORKDIR}/docs/agents/hermes/scripts/embed-batch.ts" "$@"

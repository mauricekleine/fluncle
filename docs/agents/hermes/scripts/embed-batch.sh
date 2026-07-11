#!/usr/bin/env bash
# embed-batch.sh — bootstrap a rented GPU pod and run the batch embed (docs/gpu-batch-embed.md).
#
# NOT A CRON, and deliberately not one. The on-box `fluncle-embed` host timer embeds ONE track
# per 5-minute tick on rave-02, which is CPU-only; this is the same job on a rented GPU, for the
# catalogue-scale backfill the box would take years to do. A GPU pod bills by the minute, so it
# is an OPERATOR act from first to last: the operator rents the pod, runs this, and destroys it.
# Nothing in this repo can start one.
#
# THE RUN IS BOUNDED BY THE CLOCK. You rent an HOUR, not a batch — so `--minutes` is the flag that
# matters, and the run keeps pulling pages until the queue is dry or the budget is spent. Match it
# to the block you rented, MINUS a margin: one minute past an hour boundary buys a whole second
# hour. 55 (the default) for a one-hour rental; 115 for two.
#
# It is idempotent and safe to re-run: an embedded track leaves the `embedding_json IS NULL`
# queue, so a second pass simply picks up whatever the first did not finish. A reclaimed spot
# pod costs you the page in flight and nothing else.
#
# Run ON THE POD, from RunPod's PyTorch template (CUDA + torch already present):
#
#     curl -fsSL https://raw.githubusercontent.com/mauricekleine/fluncle/main/docs/agents/hermes/scripts/embed-batch.sh \
#       | bash -s -- --minutes 55
#
# Every argument is forwarded to the orchestrator (--minutes / --limit / --scope / --dry-run).
#
# SECRETS come from the environment — set them on the pod before running (RunPod's env editor,
# or an `export` in the pod's shell). NEVER bake them into an image, and never into this file:
#
#   FLUNCLE_API_TOKEN                        the box's AGENT-scoped token (queue read + write-back)
#   R2_ACCOUNT_ID                            the (non-secret) Cloudflare account id
#   FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID    R2 token, Object READ on fluncle-source-audio
#   FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY
#
#   optional: FLUNCLE_API_BASE_URL (default https://www.fluncle.com)
#             MUQ_WINDOW_BATCH    (default 8 here — raise until VRAM complains, then step back)
#             FLUNCLE_EMBED_DOWNLOAD_CONCURRENCY (default 6 — raise if the GPU idles on downloads)
#             FLUNCLE_EMBED_RUN_MINUTES (the `--minutes` default, 55)
set -euo pipefail

REPO_URL="${FLUNCLE_REPO_URL:-https://github.com/mauricekleine/fluncle.git}"
WORKDIR="${FLUNCLE_POD_WORKDIR:-/workspace/fluncle}"

# The GPU knobs. `embed-track.py` runs the SAME decode → window → pool → normalize pipeline on
# both devices — these only choose the device and how many ~30s windows ride one forward, so a
# GPU-embedded track lands in the same vector space as a box-embedded one.
export MUQ_DEVICE="${MUQ_DEVICE:-cuda}"
export MUQ_WINDOW_BATCH="${MUQ_WINDOW_BATCH:-8}"

missing=()
for var in FLUNCLE_API_TOKEN R2_ACCOUNT_ID FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY; do
  # Test the KEY, never expanding the VALUE — `${!var:+SET}` yields "SET" or "".
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

echo "==> muq + numpy (torch is already in the PyTorch template — do NOT reinstall it, the"
echo "    template's build is the one matched to this pod's CUDA)"
python3 -m pip install --quiet --upgrade muq numpy

echo "==> repo"
if [ -d "${WORKDIR}/.git" ]; then
  git -C "${WORKDIR}" fetch --depth 1 origin main
  git -C "${WORKDIR}" reset --hard origin/main
else
  git clone --depth 1 "${REPO_URL}" "${WORKDIR}"
fi

echo "==> warming the MuQ weights (a first `from_pretrained` downloads ~1 GB; do it once, before"
echo "    the batch, so a slow HF pull is not billed as GPU time inside the run)"
python3 - <<'PY'
from muq import MuQ
MuQ.from_pretrained("OpenMuQ/MuQ-large-msd-iter")
print("MuQ weights cached")
PY

echo "==> batch (device=${MUQ_DEVICE}, window batch=${MUQ_WINDOW_BATCH})"
echo "    the run is bounded by the CLOCK — pass --minutes to match the block you rented"
exec bun "${WORKDIR}/docs/agents/hermes/scripts/embed-batch.ts" "$@"

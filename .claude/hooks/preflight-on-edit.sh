#!/usr/bin/env bash
# PostToolUse(Edit|Write): start the fingerprinted affected quality lanes without blocking
# (`bun run quality:preflight -- start`), so `quality:preflight -- join` before a commit finds the
# work already done. Always exits 0: a preflight that cannot start must never block an edit.
#
# UNATTENDED (FLUNCLE_UNATTENDED=1, exported by the agentic box sweeps): skip. The lanes include
# the type-aware lint and typecheck, whose tsgolint/tsc peaks (2.5–3 GB) the Hermes container's
# memory cap kills mid-run — and a headless `claude -p` in the checkout inherits this hook on every
# edit it makes. The box's scoped verification is audit/verify.sh; the PR's CI runs the full lanes.
set -uo pipefail
[ "${FLUNCLE_UNATTENDED:-}" = "1" ] && exit 0
bun run quality:preflight -- start --quiet >/dev/null 2>&1 || true
exit 0

# @fluncle/live — the glass

The live runtime: Fluncle's journey rendered through the ship's glass while the
operator mixes. Two local processes — the **glass** (`bun run glass`, the WebGL
renderer page on :4173) and the **bridge** (`bun run bridge`, plan +
fingerprint identity + supervisor + phone remote on :4180) — bound by
`src/contract.ts`. Local-only by design (the never-crash rail: no network
dependency mid-show). The doctrine and architecture live in
[docs/live-longform-visuals-rfc.md](../../docs/live-longform-visuals-rfc.md);
`src/glass/serve.ts` is the working v0.6 seed this package productionizes.

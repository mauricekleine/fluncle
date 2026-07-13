# RFC: MusicKit as Fluncle's second metadata authority — the remaining tail: U2b

**Status:** In flight — the bulk shipped; this file carries only what is not yet built. U0 (the oracle, #548 + the inlined-albums correction #295df8f0), U1 (the facts keystone, #550), U2a (label aliases, #563), U3a/U3b (the DTO cover fix + owned masters — doctrine now in [docs/album-artwork.md](./album-artwork.md)), U4 (the exact-ISRC preview rung, #554), U5 (Apple editorial notes as facts fuel behind the mechanical echo gate, #556), the cross-cutting Apple failure-regime breaker (`apple-breaker.ts` + the operator `reset_apple_breaker` op), and the `force_capture` dupe-veto escape hatch (`forceCapture` + the operator op, doctrine now in [docs/the-ear.md](./the-ear.md) § Duplicates) are all built and live; the carried `findings` reliability columns were dropped in #568. Per the prune rule, everything shipped has been removed from this file — it lives in the code and in `docs/album-artwork.md`, `docs/label-entity.md`, `docs/catalogue-crawler.md`, `docs/the-ear.md`, and `docs/track-lifecycle.md`. What remains: **U2b** (the label merge op + slug redirects, deliberately staged behind real U2a alias data).
**For:** a build agent; each unit is a delegable worktree slice.
**Canon/authority:** the codebase, `docs/label-entity.md`, `docs/the-ear.md`, `docs/track-lifecycle.md`, DESIGN.md/VOICE.md/PRODUCT.md. This is planning, not spec — canon wins on conflict.

## U2b — label merge + redirects (the split cleanup)

U2a stopped the split going FORWARD: an Apple `recordLabel` that survives the distributor denylist and agrees (by slug-fold) with MusicBrainz becomes a `label_aliases` candidate, and `ensureLabel`/`reconcileLabels` consult confirmed aliases before minting, so a second spelling resolves to the canonical label instead of minting a twin. U2b cleans up the PRE-EXISTING splits — the Medschool / Med School class — once real candidates have flowed for a while (they have been flowing since #563 merged).

The operator merge op (`merge_label`, operator tier, `verb_noun`):

- Re-point `tracks.label_id` from the losing row to the canonical row atomically.
- `seed_state` resolves by `ruled_at` precedence; an operator-vs-operator conflict **stops and asks** rather than silently picking a side.
- The losing row's `mb_label_id` / `discogs_label_id` / `image_key` reconcile onto the canonical (never lose a logo).
- The losing slug **301s** to the canonical `/label/<slug>`, and the sitemap emits only the canonical.
- The losing name lands in `label_aliases` as `confirmed`, so the immutable `tracks.label` free-text can never re-mint the merged-away slug on a later deploy backfill.

**Docs:** `docs/label-entity.md` gains the merge section when this ships.

**Acceptance:** the merge op with `ruled_at` precedence + stop-and-ask tested; the re-mint-after-merge regression covered; the 301 + canonical-only sitemap verified live on a real merged pair.

## Sequencing

U2b is the last unit; it is its own PR, and deploy-triggering merges stay spaced (Cloudflare build coalescing). It adds no column: U2b re-points `label_id` and reconciles rows inside a transaction.

## Risks & open questions

- **Alias merges are the one user-visible risk** (slug 301s, seed-state precedence) — mitigated by having staged U2b behind real candidate flow, plus stop-and-ask and tests.

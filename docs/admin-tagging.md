# Admin tagging — the vibe map (retired)

**Retired 2026-07-06.** Manual vibe placement is no longer part of the pipeline: a signal test (n=45, leave-one-out) proved audio cannot learn the placement — the mood axis lands at coin-flip — so the manual step, whose only forward justification was training an auto-placement model, was dropped rather than enshrined. Sonic grouping now comes free from the per-finding MuQ audio embedding; the decision record and successor design are [audio-embedding-rfc.md](./audio-embedding-rfc.md), and the live data model is [track-lifecycle.md](./track-lifecycle.md). The four galaxies survive as brand fiction. Web admin auth, which used to live in this doc, moved to [admin-shell.md](./admin-shell.md).

This page stays as the record of what the retired system left behind and the operator-loop pattern worth reusing.

## The dormant columns

`tracks.vibe_x` / `tracks.vibe_y` (`real`, nullable, roughly `-1..1`) remain in the schema, unread: X was mood (Light ← → Dark), Y was energy (Floaty ↓ ↑ Driving). The galaxy was always derived, never stored — `galaxyForVibe(x, y)` in `apps/web/src/lib/galaxies.ts` maps the quadrant signs to Solar (driving + light), Nebular (driving + dark), Lunar (floaty + light), and Astral (floaty + dark). Grouping now derives from `embedding_json` clusters instead.

## The operator-loop pattern (what to reuse)

The tagging loop was the proven per-item operator loop, and new admin queues reuse its shape: a worklist that narrows the board to the not-yet-done backlog, one keyboard-driven dialog per item, placement made **relative** to already-done siblings shown in context, and an optimistic save that flips the cell and keeps the backdrop in step. The artist follow queue ([artist-relationship-rfc.md](./artist-relationship-rfc.md)) picks this up as its pattern precedent.

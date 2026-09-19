// THE CAPTURE LADDER'S VOCABULARY — the one place the pre-audio tier's rungs, their stored
// integers, and the words the operator reads for them are written down (docs/the-ear.md § the
// pre-audio capture-priority ladder).
//
// WHY IT IS ITS OWN, CLIENT-SAFE MODULE. Two admin stations read the same
// `tracks.capture_priority`: The Ear (`/admin/catalogue`) names a row's rung on its chip, and the
// Funnel (`/admin/funnel`) names the same rungs down the capture-backlog table. One column named
// two ways on two pages of the same nav group is exactly the drift docs/admin-shell.md forbids, and
// the labels cannot live beside the ladder itself (`lib/server/catalogue.ts` carries `getDb`, so a
// route importing it drags the database chain toward the client — docs/client-bundle.md Rule 1).
// So the vocabulary lives here, pure — constants and a lookup, no database, no React — and the
// server module imports `CAPTURE_TIER` from it rather than declaring a second copy.

/** The rungs of the ladder, as names. Each is a claim about a track nobody has heard. */
export type CapturePriorityKind =
  | "artist"
  | "label"
  | "none"
  | "seed-label"
  | "skipped-label"
  | "unauthorized";

/**
 * The numeric tier for each rung — the stored `tracks.capture_priority`, high = capture sooner.
 *
 * THE VETO GETS ITS OWN TIER (−1), and that is load-bearing rather than cosmetic. It is distinct
 * from `none`'s 0, which keeps it visible to SQL: the capture WORK QUEUE (track-work.ts) could not
 * tell "nothing ties this to the archive, so capture it last" from "the operator ruled this label
 * out, so never spend a metered per-GB byte on it". A veto that only sorts last is not a veto —
 * the queue drains, and last eventually arrives.
 *
 * With its own tier the queue enforces it as a predicate (`capture_priority >= 0`), while every
 * DISPLAY property the-ear.md promises survives untouched: the row keeps its place in the capture
 * lens (`capture_priority is not null`), still sorts last under `order by … desc`, and still
 * carries its honest reason line. Ordered last, kept anyway — and never bought.
 *
 * ── THE NEGATIVE BAND, AND WHY `unauthorized` IS −3 ────────────────────────────────────────
 * Three distinct negatives share the "never bought, but kept and shown, ranked last" contract, and
 * their ORDER on the board (a DESC read) is by how SPECIFIC the reason is:
 *   −1 `skipped-label` — the operator's explicit ruling ("not your lane"). The hardest NO.
 *   −2 `duplicate`     — an identity fact ("already in the archive"); set outside this map, in the
 *                        sweep (see `DUPLICATE_CAPTURE_TIER` in lib/server/catalogue.ts).
 *   −3 `unauthorized`  — the softest: no qualified artist yet, and the label is not `enabled`. It
 *                        reads dead last because it is the DEFAULT withholding, not a judgement —
 *                        and it is the one most likely to FLIP to authorized as the
 *                        `track_artists` graph drains or the operator enables a label.
 * All three are excluded from the capture queue by the single `capture_priority >= 0` predicate
 * (track-work.ts) — no new mechanism, one more value riding a rail that already exists.
 */
export const CAPTURE_TIER: Record<CapturePriorityKind, number> = {
  artist: 3,
  label: 2,
  none: 0,
  "seed-label": 1,
  "skipped-label": -1,
  unauthorized: -3,
};

/** The rung, spoken — quiet data, never an alarm. A cold track is not a failure. */
export const CAPTURE_TIER_LABELS: Record<CapturePriorityKind, string> = {
  artist: "Known artist",
  label: "Known label",
  none: "Cold",
  "seed-label": "Seed label",
  "skipped-label": "Not our lane",
  unauthorized: "Not qualified",
};

/**
 * A stored `capture_priority` → the label the operator reads for it, so a surface holding only the
 * integer (the funnel's backlog buckets, which count by tier rather than by row) names the rung the
 * same way the surface holding the reason does. An integer outside the ladder — only
 * `DUPLICATE_CAPTURE_TIER` today — falls back to the rung's own honest name rather than a bare
 * number, because "−2" is a string nobody has a meaning for.
 */
export function captureTierLabelFor(priority: number): string {
  for (const kind of Object.keys(CAPTURE_TIER_LABELS) as CapturePriorityKind[]) {
    if (CAPTURE_TIER[kind] === priority) {
      return CAPTURE_TIER_LABELS[kind];
    }
  }

  return priority === -2 ? "Already in the archive" : "Unranked";
}

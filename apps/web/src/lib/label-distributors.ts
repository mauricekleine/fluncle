// THE DISTRIBUTOR DENYLIST (RFC musickit-second-authority, U2a — panel-mandated).
//
// Client-safe and dependency-light (only `labelFold` from @fluncle/contracts), so BOTH the
// runtime server module (`lib/server/labels.ts`) and the deploy-time derivation
// (`scripts/backfill-label-aliases.ts`) read ONE source of truth. The deploy scripts run in
// plain bun outside the Worker, where the server modules' Cloudflare-env imports do not load —
// hence this split-out.
//
// WHY IT EXISTS: ISRC identity alone does NOT clean `recordLabel`. Apple's album `recordLabel`
// is very often the DISTRIBUTOR that put the release out, not the imprint — and a distributor
// string agreeing with itself across pressings is not evidence about the label. So a denylisted
// `recordLabel` never becomes an alias CANDIDATE (the U2a derivation drops it, `hint` at most).
// The seed set is the common DnB-adjacent distributors; it is OPERATOR-EXTENDABLE (add a name).

import { labelFold } from "@fluncle/contracts/util/galaxy-slug";

/** The seeded distributors. Matched by {@link labelFold}, so spacing/punctuation collapses. */
export const DISTRIBUTOR_DENYLIST = [
  "Believe",
  "AEI",
  "Kontor New Media",
  "The Orchard",
  "Absolute",
  "FUGA",
  "Ingrooves",
  "Symphonic",
  "ADA",
  "Horus Music",
] as const;

/** The denylist as its folded set — computed once, matched by exact fold equality. */
const DISTRIBUTOR_DENYLIST_FOLDED = new Set(DISTRIBUTOR_DENYLIST.map((name) => labelFold(name)));

/**
 * Is this raw label name a known DISTRIBUTOR rather than an imprint? True for a
 * {@link DISTRIBUTOR_DENYLIST} entry (folded). A distributor `recordLabel` is never trusted into
 * the graph as a candidate — the panel's "the ISRC anchor must do real work" guardrail.
 */
export function isDistributorLabel(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") {
    return false;
  }

  return DISTRIBUTOR_DENYLIST_FOLDED.has(labelFold(raw));
}

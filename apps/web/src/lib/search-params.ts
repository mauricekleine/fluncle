// The shared `validateSearch` coercers — the tolerant URL-param narrowing every paged public
// hub applies before its loader ever runs. A reader (or a crawler) can put anything in a query
// string, so each of these folds junk to `undefined` rather than throwing or clamping: an
// unparseable param simply drops, leaving the bare, canonical view.
//
// WHY NOT `lib/server/query-params.ts`. That module holds the same shape of coercion for the
// HTTP surfaces (`parseLimit` / `parseBool` over `URLSearchParams.get`), but it lives under
// `lib/server/**` — and a route's `validateSearch` is EAGERLY bundled into the client entry
// chunk (docs/client-bundle.md, Rule 1, build-enforced by the `fluncle-eager-chunk-purity`
// gate). A route may not reach into `lib/server/**` for these, so the client-side vocabulary
// gets its own pure home here, next to `log-page-param.ts`.

/** A page param the reader typed: junk or an absent value folds to undefined (the param-free view). */
export function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

/** A trimmed non-empty string param (a name search, a key, a slug list); empty / non-string folds
    to undefined. */
export function textParam(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

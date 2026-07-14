// Pure, DOM-free logic for the `/mix` Save-set dialog — the disabled gate and the request
// body — split out so both can be unit-tested (see mix-save.test.ts) without mounting the
// dialog. The wiring (the /api/me probe, CSRF, PATCH-then-POST, adopting the returned id)
// lives in the component (save-set-dialog.tsx).
//
// THE RULING (2026-07-14): Save always reads the LIVE CHAIN, never the `?set=` URL param, and
// an actually-empty chain is blocked in the dialog (Save disabled) rather than by a server
// error after the fact. `canSaveSet` is that gate; the empty-chain guard is defensive (the
// trigger only shows on a non-empty chain), while the blank-name guard is the active one — the
// ruling says a set is saved under a NAME the reader enters.

/** The saved-set request body — the same `{ name, set, taste }` the web + mobile both POST/PATCH. */
export function buildSaveSetBody(
  name: string,
  serializedSet: string,
  serializedTaste: string,
): { name: string; set: string; taste: string } {
  return { name: name.trim(), set: serializedSet, taste: serializedTaste };
}

/**
 * True ⇔ the dialog's Save action is allowed: there is a live chain to save AND the reader
 * has entered a non-blank name. Whitespace is not a name.
 */
export function canSaveSet({ chainLength, name }: { chainLength: number; name: string }): boolean {
  return chainLength > 0 && name.trim().length > 0;
}

// The one identity predicate the artist-rule surfaces share, in a CLIENT-SAFE module.
//
// The dialog's add form needs it in the browser (to tell a pasted MusicBrainz id from a typed
// name) and the typeahead read needs it on the server. It lives on its own, with no imports, so
// the browser half never drags `lib/server/**` behind it (docs/client-bundle.md, fix 1).

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a typed value is already an exact MusicBrainz artist id. A rule matches on the MBID and
 * nothing else — never a name, never a local `artists.id` — so this is what separates
 * "paste an identity" from "search for one".
 */
export function isMbid(value: string): boolean {
  return MBID.test(value.trim());
}

// The single safe sink for JSON-LD.
//
// Every `application/ld+json` block is emitted through a route `head().scripts`
// entry, whose string `children` TanStack renders RAW via dangerouslySetInnerHTML
// (no escaping). `JSON.stringify` does NOT neutralize `</script>`, so an untrusted
// string in the structured data - a Spotify-sourced track title / artist / album,
// or the operator `note` woven into the log description - could carry a literal
// `</script><script>...` that breaks out of the inline <script> and executes on
// the public, server-rendered page (stored XSS; there is no CSP to contain it).
//
// `jsonLdScript` is the one place we serialize JSON-LD: it stringifies, then
// HTML-escapes the bytes that matter in a <script> context before they reach
// `children`. The escaped sequences are still valid JSON (each is a `\\uXXXX`
// escape), so a JSON-LD parser reads the original data - only the HTML-context
// breakout is removed. This mirrors the framework's own `script:ld+json` path
// (which calls the same escaping); we apply it on the `scripts` path the app
// uses. Route every JSON-LD emitter through this helper.

/** A JSON-LD object: any plain object that survives `JSON.stringify`. */
export type JsonLd = Record<string, unknown>;

// `<`/`>`/`&` neutralize the `</script>` / `<!--` / `<script` breakouts; U+2028
// and U+2029 are valid JSON whitespace but terminate a JS string literal, so they
// are escaped too. Each replacement is a `\\uXXXX` JSON escape, so the serialized
// string still parses to the original data.
const JSON_LD_ESCAPES: Record<string, string> = {
  "&": "\\u0026",
  "<": "\\u003c",
  ">": "\\u003e",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * Serialize a JSON-LD object and escape it for safe embedding inside an inline
 * `<script>` rendered via `dangerouslySetInnerHTML`. Escapes `<`, `>`, `&`, and
 * the U+2028/U+2029 line separators to their `\\uXXXX` JSON forms - neutralizing
 * a `</script>` (or `<!--`, `<script`) breakout while keeping the payload valid
 * JSON-LD.
 */
export function serializeJsonLd(jsonLd: JsonLd): string {
  return JSON.stringify(jsonLd).replace(
    /[<>&\u2028\u2029]/g,
    (char) => JSON_LD_ESCAPES[char] ?? char,
  );
}

/**
 * Build a route `head().scripts` entry for a JSON-LD object, with the serialized
 * payload HTML-escaped (see `serializeJsonLd`). Use this for every
 * `application/ld+json` block instead of `JSON.stringify` inline.
 */
export function jsonLdScript(jsonLd: JsonLd): {
  children: string;
  type: "application/ld+json";
} {
  return { children: serializeJsonLd(jsonLd), type: "application/ld+json" };
}

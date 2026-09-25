export type JsonLd = Record<string, unknown>;

const JSON_LD_ESCAPES: Record<string, string> = {
  "&": "\\u0026",
  "<": "\\u003c",
  ">": "\\u003e",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function serializeJsonLd(jsonLd: JsonLd): string {
  return JSON.stringify(jsonLd).replace(
    /[<>&\u2028\u2029]/g,
    (char) => JSON_LD_ESCAPES[char] ?? char,
  );
}

export function jsonLdScript(jsonLd: JsonLd): {
  children: string;
  type: "application/ld+json";
} {
  return { children: serializeJsonLd(jsonLd), type: "application/ld+json" };
}

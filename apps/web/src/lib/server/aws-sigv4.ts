// A minimal AWS Signature V4 header signer for S3-compatible endpoints (Cloudflare
// R2), built on WebCrypto so it runs unchanged in the Worker, Node/vitest, and Bun.
//
// The app itself signs R2 via `aws4fetch` (see `r2-presign.ts`); this standalone
// signer exists for the ONE caller that cannot bring a dependency: the self-contained
// on-box backup sweep (`docs/agents/hermes/scripts/backup-sweep.ts`), which uploads
// the daily dump straight to a private R2 bucket with no node_modules on the box. That
// sweep MIRRORS `signS3Request` verbatim — keep the two in step. `aws-sigv4.test.ts`
// pins this implementation to `aws4fetch` (the trusted reference already in the repo)
// so any drift is caught, and it uploads with a REAL payload hash (a signed payload —
// R2 validates the body against it, catching a truncated/corrupted upload).

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  let hex = "";

  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;

  return toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/** RFC 3986 escaping beyond what `encodeURIComponent` covers (`! * ' ( )`). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Canonical URI: each path segment RFC-3986 encoded, slashes preserved. */
function canonicalUri(pathname: string): string {
  return pathname.split("/").map(encodeRfc3986).join("/");
}

/** Canonical query string: params RFC-3986 encoded and sorted by key then value. */
function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const,
  );

  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );

  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

/** The `YYYYMMDDTHHMMSSZ` AMZ timestamp for a given instant. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export type SignS3RequestOptions = {
  accessKeyId: string;
  /** The request body (its real SHA-256 is signed). Omit for GET/DELETE. */
  body?: Uint8Array;
  contentType?: string;
  method: string;
  now: Date;
  region: string;
  secretAccessKey: string;
  service: string;
  url: string;
};

/**
 * Sign an S3/R2 request and return the headers to SEND (Authorization plus the
 * `x-amz-*` set; `host` is implicit from the URL, so it is signed but not returned).
 * Verified byte-for-byte against `aws4fetch` in `aws-sigv4.test.ts`.
 */
export async function signS3Request(
  options: SignS3RequestOptions,
): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const stamp = amzDate(options.now);
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(options.body ?? new Uint8Array());

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };

  if (options.contentType) {
    headers["content-type"] = options.contentType;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    options.method,
    canonicalUri(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );

  let signingKey: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${options.secretAccessKey}`);

  for (const part of [dateStamp, options.region, options.service, "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }

  const signature = toHex(await hmac(signingKey, stringToSign));

  // `host` is set by fetch from the URL — return everything else the request must carry.
  const { host: _host, ...sent } = headers;

  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

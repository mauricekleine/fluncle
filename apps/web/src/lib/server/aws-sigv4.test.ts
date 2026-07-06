import { AwsClient } from "aws4fetch";
import { describe, expect, it } from "vitest";

import { amzDate, signS3Request } from "./aws-sigv4";

// Pin the hand-rolled signer to `aws4fetch` (the trusted reference the app already
// uses in r2-presign.ts): sign the same request both ways and assert byte-identical
// Authorization. The box backup sweep mirrors `signS3Request`, so this is the guard
// that the mirror — and the signer itself — stays correct.

const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  region: "auto",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  service: "s3",
};

const NOW = new Date("2026-07-06T12:34:56.000Z");
const ENDPOINT = "https://acct.r2.cloudflarestorage.com";

async function referenceAuth(
  method: string,
  url: string,
  body?: Uint8Array,
  contentType?: string,
): Promise<string | null> {
  const enc = new TextEncoder();
  const digestInput = (body ?? enc.encode("")) as unknown as ArrayBuffer;
  const payloadHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const headers: Record<string, string> = {
    // aws4fetch defaults S3 to UNSIGNED-PAYLOAD; force the real hash so both sign the
    // signed-payload form our signer always uses.
    "x-amz-content-sha256": payloadHash,
  };

  if (contentType) {
    headers["content-type"] = contentType;
  }

  const client = new AwsClient(CREDS);
  const signed = await client.sign(url, {
    aws: { allHeaders: true, datetime: amzDate(NOW) },
    body: body as BodyInit | undefined,
    headers,
    method,
  });

  return signed.headers.get("authorization");
}

describe("signS3Request", () => {
  it("matches aws4fetch for a PUT with a body and content-type", async () => {
    const url = `${ENDPOINT}/fluncle-backups/db-backups/daily/2026-07-06/fluncle.sql.gz`;
    const body = new Uint8Array([1, 2, 3, 4, 5]);

    const signed = await signS3Request({
      ...CREDS,
      body,
      contentType: "application/gzip",
      method: "PUT",
      now: NOW,
      url,
    });

    expect(signed.authorization).toBe(await referenceAuth("PUT", url, body, "application/gzip"));
    // Sends the x-amz set but never a Host header (fetch derives it from the URL).
    expect(signed.host).toBeUndefined();
    expect(signed["x-amz-date"]).toBe("20260706T123456Z");
    expect(signed["content-type"]).toBe("application/gzip");
  });

  it("matches aws4fetch for a GET list request with a query string", async () => {
    const url = `${ENDPOINT}/fluncle-backups?list-type=2&prefix=db-backups/daily/`;

    const signed = await signS3Request({ ...CREDS, method: "GET", now: NOW, url });

    expect(signed.authorization).toBe(await referenceAuth("GET", url));
  });

  it("matches aws4fetch for a DELETE with no body or query", async () => {
    const url = `${ENDPOINT}/fluncle-backups/db-backups/daily/2026-01-01/fluncle.sql.gz`;

    const signed = await signS3Request({ ...CREDS, method: "DELETE", now: NOW, url });

    expect(signed.authorization).toBe(await referenceAuth("DELETE", url));
  });

  it("formats the AMZ timestamp as YYYYMMDDTHHMMSSZ", () => {
    expect(amzDate(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});

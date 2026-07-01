import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  MULTIPART_PRESIGN_TTL_SECONDS,
  PRESIGN_TTL_SECONDS,
  VIDEOS_BUCKET,
  copyObject,
  deleteObject,
  parseUploadId,
  presignMultipartAction,
  presignMultipartParts,
  presignUploads,
} from "./r2-presign";

// Mock R2 S3-API creds. readEnvs reads process.env at call time (not import
// time), so setting them here is enough; the account id pins the S3 endpoint.
const ACCOUNT_ID = "0651fd3b33d9e0b2fe72a5f13e5cf65d";

beforeAll(() => {
  process.env.R2_ACCESS_KEY_ID = "test-access-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-access-key";
  process.env.R2_ACCOUNT_ID = ACCOUNT_ID;
});

describe("presignUploads", () => {
  it("signs a well-formed presigned PUT URL for each artifact", async () => {
    const targets = [
      { contentType: "video/mp4", key: "004.7.2I/footage.mp4" },
      { contentType: "image/jpeg", key: "004.7.2I/cover.jpg" },
    ];

    const uploads = await presignUploads(VIDEOS_BUCKET, targets);

    expect(uploads).toHaveLength(2);

    for (const [index, upload] of uploads.entries()) {
      const url = new URL(upload.url);

      // Host is the R2 S3 endpoint for this account.
      expect(url.host).toBe(`${ACCOUNT_ID}.r2.cloudflarestorage.com`);
      // Path is /<bucket>/<key>, exact.
      expect(url.pathname).toBe(`/${VIDEOS_BUCKET}/${targets[index]?.key}`);
      // SigV4 query params are present.
      expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get("X-Amz-Expires")).toBe(String(PRESIGN_TTL_SECONDS));
      expect(url.searchParams.get("X-Amz-Credential")).toContain("test-access-key-id");
      // Region "auto", service "s3" in the credential scope.
      expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
      // Content-Type is baked into the signature (the classic gotcha): the CLI
      // MUST PUT with this exact header or R2 returns SignatureDoesNotMatch.
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
      // The contentType the CLI must replay is returned alongside the URL.
      expect(upload.contentType).toBe(targets[index]?.contentType);
      expect(upload.key).toBe(targets[index]?.key);
    }
  });

  it("binds a different signature to a different content-type", async () => {
    const [asMp4] = await presignUploads(VIDEOS_BUCKET, [
      { contentType: "video/mp4", key: "004.7.2I/footage.mp4" },
    ]);
    const [asJpeg] = await presignUploads(VIDEOS_BUCKET, [
      { contentType: "image/jpeg", key: "004.7.2I/footage.mp4" },
    ]);

    if (asMp4 === undefined || asJpeg === undefined) {
      throw new Error("expected both presign results");
    }

    // Same key, different baked Content-Type → different signature.
    expect(new URL(asMp4.url).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(asJpeg.url).searchParams.get("X-Amz-Signature"),
    );
  });
});

// The multipart presign for the mixtape set-video rendition. CreateMultipartUpload
// (the one network call) is NOT exercised here — only the pure pieces it composes:
// the UploadId parse + the part / complete / abort URL signers (aws4fetch signs
// locally), which is the whole surface CI can verify without a live R2 endpoint.
describe("parseUploadId", () => {
  it("pulls the UploadId out of a CreateMultipartUpload XML response", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>fluncle-videos</Bucket><Key>019.F.1A/set.mp4</Key><UploadId>abc123-DEF456_uploadid</UploadId></InitiateMultipartUploadResult>`;

    expect(parseUploadId(xml)).toBe("abc123-DEF456_uploadid");
  });

  it("throws when the response carries no UploadId", () => {
    expect(() => parseUploadId("<Error><Code>NoSuchBucket</Code></Error>")).toThrow(/UploadId/);
  });
});

describe("presignMultipartParts", () => {
  const KEY = "019.F.1A/set.mp4";
  const UPLOAD_ID = "abc123-DEF456_uploadid";

  it("signs one well-formed part PUT URL per part, 1-based", async () => {
    const parts = await presignMultipartParts(VIDEOS_BUCKET, KEY, UPLOAD_ID, 3);

    expect(parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);

    for (const part of parts) {
      const url = new URL(part.url);

      expect(url.host).toBe(`${ACCOUNT_ID}.r2.cloudflarestorage.com`);
      expect(url.pathname).toBe(`/${VIDEOS_BUCKET}/${KEY}`);
      // The S3 part contract: partNumber + uploadId ride in the query, signed.
      expect(url.searchParams.get("partNumber")).toBe(String(part.partNumber));
      expect(url.searchParams.get("uploadId")).toBe(UPLOAD_ID);
      expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get("X-Amz-Expires")).toBe(String(MULTIPART_PRESIGN_TTL_SECONDS));
      // Parts carry no baked Content-Type (the object's type was set at create time).
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    }
  });

  it("binds a distinct signature to each part number", async () => {
    const parts = await presignMultipartParts(VIDEOS_BUCKET, KEY, UPLOAD_ID, 2);
    const [first, second] = parts;

    if (first === undefined || second === undefined) {
      throw new Error("expected two parts");
    }

    expect(new URL(first.url).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(second.url).searchParams.get("X-Amz-Signature"),
    );
  });

  it("rejects an out-of-range part count", async () => {
    await expect(presignMultipartParts(VIDEOS_BUCKET, KEY, UPLOAD_ID, 0)).rejects.toThrow(
      /partCount/,
    );
    await expect(presignMultipartParts(VIDEOS_BUCKET, KEY, UPLOAD_ID, 10_001)).rejects.toThrow(
      /partCount/,
    );
  });
});

// The server-side copy + delete (the promote path). aws4fetch signs locally then calls
// the global `fetch`, so spying on it captures the exact signed Request without a live R2.
describe("copyObject / deleteObject request shapes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("HEADs the source, then PUTs a same-bucket copy with x-amz-copy-source", async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      requests.push(request);

      if (request.method === "HEAD") {
        return new Response(null, { headers: { "content-length": "2000000000" }, status: 200 });
      }

      return new Response(
        `<?xml version="1.0"?><CopyObjectResult><ETag>"abc"</ETag></CopyObjectResult>`,
        { status: 200 },
      );
    });

    await copyObject("recordings/rec-1/set.mp4", "020.F.1A/set.mp4");

    expect(requests).toHaveLength(2);
    const [head, put] = requests;

    if (!head || !put) {
      throw new Error("expected a HEAD then a PUT");
    }

    // First: a HEAD of the source (the ≤ 5 GiB ceiling check).
    expect(head.method).toBe("HEAD");
    expect(new URL(head.url).pathname).toBe(`/${VIDEOS_BUCKET}/recordings/rec-1/set.mp4`);

    // Then: a PUT of the DEST carrying the copy-source header pointing at the SAME bucket.
    expect(put.method).toBe("PUT");
    expect(new URL(put.url).pathname).toBe(`/${VIDEOS_BUCKET}/020.F.1A/set.mp4`);
    expect(put.headers.get("x-amz-copy-source")).toBe(`/${VIDEOS_BUCKET}/recordings/rec-1/set.mp4`);
  });

  it("treats a <Error> body as failure even on a 200", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;

      if (request.method === "HEAD") {
        return new Response(null, { headers: { "content-length": "1000" }, status: 200 });
      }

      return new Response(`<Error><Code>AccessDenied</Code></Error>`, { status: 200 });
    });

    await expect(copyObject("recordings/rec-1/set.mp4", "020.F.1A/set.mp4")).rejects.toThrow(
      /CopyObject/,
    );
  });

  it("refuses a source over the 5 GiB single-copy ceiling (no PUT issued)", async () => {
    let puts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;

      if (request.method === "HEAD") {
        // 6 GiB — over the ceiling.
        return new Response(null, {
          headers: { "content-length": String(6 * 1024 * 1024 * 1024) },
          status: 200,
        });
      }

      puts += 1;
      return new Response("<CopyObjectResult/>", { status: 200 });
    });

    await expect(copyObject("recordings/rec-1/set.mp4", "020.F.1A/set.mp4")).rejects.toThrow(
      /5 GiB/,
    );
    expect(puts).toBe(0);
  });

  it("DELETEs a key and tolerates an already-gone (404) object", async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(input as Request);
      return new Response(null, { status: 404 });
    });

    // A 404 is not an error (S3 DELETE is idempotent) — this must not throw.
    await expect(deleteObject("recordings/rec-1/set.mp4")).resolves.toBeUndefined();

    const [del] = requests;

    if (!del) {
      throw new Error("expected a DELETE");
    }

    expect(del.method).toBe("DELETE");
    expect(new URL(del.url).pathname).toBe(`/${VIDEOS_BUCKET}/recordings/rec-1/set.mp4`);
  });
});

describe("presignMultipartAction", () => {
  const KEY = "019.F.1A/set.mp4";
  const UPLOAD_ID = "abc123-DEF456_uploadid";

  it("signs the complete (POST) + abort (DELETE) URLs over the same upload", async () => {
    const completeUrl = await presignMultipartAction(VIDEOS_BUCKET, KEY, UPLOAD_ID, "POST");
    const abortUrl = await presignMultipartAction(VIDEOS_BUCKET, KEY, UPLOAD_ID, "DELETE");

    for (const raw of [completeUrl, abortUrl]) {
      const url = new URL(raw);

      expect(url.pathname).toBe(`/${VIDEOS_BUCKET}/${KEY}`);
      // The completion/abort target by uploadId only (no partNumber).
      expect(url.searchParams.get("uploadId")).toBe(UPLOAD_ID);
      expect(url.searchParams.get("partNumber")).toBeNull();
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    }

    // Different HTTP method → different signature.
    expect(new URL(completeUrl).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(abortUrl).searchParams.get("X-Amz-Signature"),
    );
  });
});

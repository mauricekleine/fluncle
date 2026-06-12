import { beforeAll, describe, expect, it } from "vitest";

import { PRESIGN_TTL_SECONDS, VIDEOS_BUCKET, presignUploads } from "./r2-presign";

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
      expect(url.pathname).toBe(`/${VIDEOS_BUCKET}/${targets[index].key}`);
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
      expect(upload.contentType).toBe(targets[index].contentType);
      expect(upload.key).toBe(targets[index].key);
    }
  });

  it("binds a different signature to a different content-type", async () => {
    const [asMp4] = await presignUploads(VIDEOS_BUCKET, [
      { contentType: "video/mp4", key: "004.7.2I/footage.mp4" },
    ]);
    const [asJpeg] = await presignUploads(VIDEOS_BUCKET, [
      { contentType: "image/jpeg", key: "004.7.2I/footage.mp4" },
    ]);

    // Same key, different baked Content-Type → different signature.
    expect(new URL(asMp4.url).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(asJpeg.url).searchParams.get("X-Amz-Signature"),
    );
  });
});

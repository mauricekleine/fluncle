import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortMultipart,
  isAbortError,
  MAX_PART_ATTEMPTS,
  PermanentUploadError,
  presignRecordingUpload,
  type RecordingPresign,
  type UploadProgress,
  uploadFileToPresign,
} from "./recording-upload";

// The BROWSER multipart uploader's failure ladder. Everything here is the half that the CLI
// sibling cannot share: the XHR transport, the per-part retry/backoff, the CORS ETag
// contract, and the best-effort abort that keeps a failed upload from stranding parts on R2.
// The pure core (planMultipart / buildCompleteXml) is tested in @fluncle/contracts; this file
// tests the transport policy wrapped around it.
//
// It runs under `environment: "node"`, so `XMLHttpRequest` is stubbed below rather than
// mocked out of a DOM — that stub IS the seam, and it lets every branch of `putPartOnce`
// (2xx-with-ETag, 2xx-without, 4xx, 5xx, network error, abort) be driven deterministically.
// Backoff runs on fake timers, so nothing here waits on a wall clock.

type PartOutcome =
  | { etag: string; kind: "ok" }
  | { kind: "abort-hangs" }
  | { kind: "network-error" }
  | { kind: "no-etag" }
  | { kind: "status"; status: number; statusText?: string };

type XhrLike = {
  abort: () => void;
  getResponseHeader: (name: string) => null | string;
  onabort: null | (() => void);
  onerror: null | (() => void);
  onload: null | (() => void);
  open: (method: string, url: string) => void;
  send: (body: unknown) => void;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number }) => void) | null };
};

/** Every PUT the uploader made, in order — url + the outcome the script handed it. */
const sent: { outcome: PartOutcome; url: string }[] = [];
/** The scripted outcome queue, consumed one per PUT. Exhausted ⇒ a successful part. */
let outcomes: PartOutcome[] = [];

function nextOutcome(): PartOutcome {
  return outcomes.shift() ?? { etag: '"default"', kind: "ok" };
}

function installFakeXhr(): void {
  class FakeXhr implements XhrLike {
    onabort: null | (() => void) = null;
    onerror: null | (() => void) = null;
    onload: null | (() => void) = null;
    upload: XhrLike["upload"] = { onprogress: null };

    private outcome: PartOutcome = { etag: '"default"', kind: "ok" };
    private settled = false;
    private status = 200;
    private statusText = "OK";
    private url = "";

    open(_method: string, url: string): void {
      this.url = url;
    }

    getResponseHeader(name: string): null | string {
      if (name.toLowerCase() !== "etag") {
        return null;
      }

      return this.outcome.kind === "ok" ? this.outcome.etag : null;
    }

    send(_body: unknown): void {
      this.outcome = nextOutcome();
      sent.push({ outcome: this.outcome, url: this.url });

      // Settle on a microtask, the way a real XHR settles off the call stack — the awaiting
      // promise chain in putPartWithRetry is what we are exercising.
      void Promise.resolve().then(() => {
        if (this.settled) {
          return;
        }

        // A byte tick before the terminal event, so the progress plumbing is exercised too.
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1 });

        switch (this.outcome.kind) {
          case "abort-hangs":
            // Never settles on its own: only `abort()` (the signal) can end this one.
            return;
          case "network-error":
            this.settled = true;
            this.onerror?.();
            return;
          case "no-etag":
            this.settled = true;
            this.status = 200;
            this.onload?.();
            return;
          case "ok":
            this.settled = true;
            this.status = 200;
            this.onload?.();
            return;
          case "status":
            this.settled = true;
            this.status = this.outcome.status;
            this.statusText = this.outcome.statusText ?? "";
            this.onload?.();
        }
      });
    }

    abort(): void {
      if (this.settled) {
        return;
      }

      this.settled = true;
      this.onabort?.();
    }
  }

  vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

/**
 * A File stand-in. `uploadFileToPresign` touches exactly `size` and `slice()`, so a real
 * multi-megabyte buffer would buy nothing but allocation (the smallest plan with two parts
 * is 16 MB + 1 byte).
 */
function fakeFile(size: number): File {
  return {
    size,
    slice: (start: number, end: number) => ({ size: end - start }) as Blob,
  } as unknown as File;
}

function presignFor(partCount: number): RecordingPresign {
  return {
    abortUrl: "https://r2.example/abort",
    completeUrl: "https://r2.example/complete",
    key: "recordings/set.mp4",
    parts: Array.from({ length: partCount }, (_, index) => ({
      partNumber: index + 1,
      url: `https://r2.example/part/${index + 1}`,
    })),
    recordingId: "rec_1",
    uploadId: "upload_1",
  };
}

/**
 * Drive the retry backoff on fake timers and hand back whatever the upload REJECTED with.
 * The rejection handler is attached before the timers advance, so the promise is never
 * momentarily unhandled, and the timer drain is what lets the backoff sleeps complete.
 */
async function rejection(pending: Promise<unknown>): Promise<unknown> {
  const settled = pending.then(
    () => ({ resolved: true }) as const,
    (error: unknown) => ({ error, resolved: false }) as const,
  );

  await vi.runAllTimersAsync();

  const outcome = await settled;

  if (outcome.resolved) {
    throw new Error("expected the upload to reject, but it resolved");
  }

  return outcome.error;
}

/** The message of a rejection, for the cases where the wording is the contract. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PART_SIZE = 16 * 1024 * 1024;
/** Every `fetch` the uploader made: the complete POST and/or the abort DELETE. */
let fetches: { method?: string; url: string }[] = [];
let fetchImpl: (url: string) => Response;

beforeEach(() => {
  vi.useFakeTimers();
  outcomes = [];
  sent.length = 0;
  fetches = [];
  fetchImpl = () => new Response("", { status: 200 });
  installFakeXhr();
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    fetches.push({ method: init?.method, url: String(input) });

    return Promise.resolve(fetchImpl(String(input)));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("uploadFileToPresign — the happy path", () => {
  it("uploads every planned part in order and completes with the stored key", async () => {
    outcomes = [
      { etag: '"a"', kind: "ok" },
      { etag: '"b"', kind: "ok" },
    ];

    const result = await uploadFileToPresign(fakeFile(PART_SIZE + 1), presignFor(2));

    expect(result).toEqual({ key: "recordings/set.mp4" });
    expect(sent.map((put) => put.url)).toEqual([
      "https://r2.example/part/1",
      "https://r2.example/part/2",
    ]);
    // The completion carries both ETags in ascending part order, and nothing was aborted.
    expect(fetches).toEqual([{ method: "POST", url: "https://r2.example/complete" }]);
  });

  it("reports byte-level progress that never exceeds the file size", async () => {
    const seen: UploadProgress[] = [];

    await uploadFileToPresign(fakeFile(PART_SIZE + 1), presignFor(2), {
      onProgress: (progress) => seen.push({ ...progress }),
    });

    expect(seen.length).toBeGreaterThan(0);

    for (const progress of seen) {
      expect(progress.totalParts).toBe(2);
      expect(progress.totalBytes).toBe(PART_SIZE + 1);
      expect(progress.uploadedBytes).toBeLessThanOrEqual(progress.totalBytes);
      expect(progress.uploadedBytes).toBeGreaterThanOrEqual(0);
    }

    // The last tick is the terminal one: both parts done, all bytes accounted for.
    const last = seen[seen.length - 1];

    expect(last?.completedParts).toBe(2);
    expect(last?.uploadedBytes).toBe(PART_SIZE + 1);
  });
});

describe("uploadFileToPresign — retry policy", () => {
  it("retries a 5xx with exponential backoff and succeeds on a later attempt", async () => {
    outcomes = [
      { kind: "status", status: 500, statusText: "Internal Error" },
      { kind: "status", status: 503, statusText: "Slow Down" },
      { etag: '"eventually"', kind: "ok" },
    ];

    const retries: NonNullable<UploadProgress["retry"]>[] = [];
    const pending = uploadFileToPresign(fakeFile(1024), presignFor(1), {
      onProgress: (progress) => {
        if (progress.retry) {
          retries.push({ ...progress.retry });
        }
      },
    });

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ key: "recordings/set.mp4" });
    expect(sent).toHaveLength(3);
    // 500 · 2^(n-1): the backoff really doubles rather than sitting at a constant.
    expect(retries.map((retry) => retry.backoffMs)).toEqual([500, 1000]);
    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2]);
  });

  it("retries a network error (a dropped socket, or a blocked CORS preflight)", async () => {
    outcomes = [{ kind: "network-error" }, { etag: '"recovered"', kind: "ok" }];

    const pending = uploadFileToPresign(fakeFile(1024), presignFor(1));

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ key: "recordings/set.mp4" });
    expect(sent).toHaveLength(2);
  });

  it("gives up after MAX_PART_ATTEMPTS and aborts the half-finished upload", async () => {
    outcomes = Array.from({ length: MAX_PART_ATTEMPTS }, () => ({
      kind: "status" as const,
      status: 500,
      statusText: "Internal Error",
    }));

    const error = await rejection(uploadFileToPresign(fakeFile(1024), presignFor(1)));

    expect(messageOf(error)).toContain(`Part 1 failed after ${MAX_PART_ATTEMPTS} attempts`);
    expect(sent).toHaveLength(MAX_PART_ATTEMPTS);
    // The orphan-cleanup rail: a failed upload never leaves parts sitting on R2.
    expect(fetches).toEqual([{ method: "DELETE", url: "https://r2.example/abort" }]);
  });
});

describe("uploadFileToPresign — permanent failures never retry", () => {
  it("surfaces a 4xx at once (the part signature is wrong; retrying cannot help)", async () => {
    outcomes = [{ kind: "status", status: 403, statusText: "Forbidden" }];

    const error = await rejection(uploadFileToPresign(fakeFile(1024), presignFor(1)));

    expect(error).toBeInstanceOf(PermanentUploadError);
    expect(sent).toHaveLength(1);
    expect(fetches).toEqual([{ method: "DELETE", url: "https://r2.example/abort" }]);
  });

  it("names the CORS misconfiguration when R2 answers 200 with no readable ETag", async () => {
    // THE CORS CONTRACT (recording-upload.ts's header): a 200 whose ETag the browser cannot
    // read means the bucket policy does not expose the header. Retrying would hang the
    // operator on a config problem, so it is permanent and it says what to fix.
    outcomes = [{ kind: "no-etag" }];

    const error = await rejection(uploadFileToPresign(fakeFile(1024), presignFor(1)));

    expect(error).toBeInstanceOf(PermanentUploadError);
    expect(messageOf(error)).toContain("ETag");
    expect(sent).toHaveLength(1);
  });

  it("refuses to start a part the presign never signed", async () => {
    // A two-part plan against a one-part presign: the mismatch is caught before any PUT,
    // so a truncated object is never assembled from a partial part list.
    const error = await rejection(uploadFileToPresign(fakeFile(PART_SIZE + 1), presignFor(1)));

    expect(messageOf(error)).toBe("The upload was not signed for part 2 of 2");
    expect(sent).toHaveLength(1);
  });
});

describe("uploadFileToPresign — abort", () => {
  it("stops on the operator's signal, does not retry, and drops the upload", async () => {
    outcomes = [{ kind: "abort-hangs" }];

    const controller = new AbortController();
    const pending = uploadFileToPresign(fakeFile(1024), presignFor(1), {
      signal: controller.signal,
    });

    // Let the PUT start before cancelling, so this is a mid-flight abort rather than a
    // pre-aborted signal.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    const error = await pending.catch((thrown: unknown) => thrown);

    expect(isAbortError(error)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(fetches).toEqual([{ method: "DELETE", url: "https://r2.example/abort" }]);
  });

  it("cancels during the retry backoff rather than sleeping it out", async () => {
    outcomes = [{ kind: "status", status: 500 }, { kind: "abort-hangs" }];

    const controller = new AbortController();
    const pending = uploadFileToPresign(fakeFile(1024), presignFor(1), {
      signal: controller.signal,
    });

    // Inside the 500ms backoff, before the second PUT is issued.
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(1);

    controller.abort();

    const error = await pending.catch((thrown: unknown) => thrown);

    expect(isAbortError(error)).toBe(true);
    // The sleep rejected instead of resolving, so the retry never fired.
    expect(sent).toHaveLength(1);
  });
});

describe("completion and abort transports", () => {
  it("treats a 200 carrying an <Error> body as a failure (R2's soft-fail shape)", async () => {
    fetchImpl = (url) =>
      url.endsWith("/complete")
        ? new Response("<Error><Code>InvalidPart</Code></Error>", { status: 200 })
        : new Response("", { status: 200 });

    const error = await rejection(uploadFileToPresign(fakeFile(1024), presignFor(1)));

    expect(messageOf(error)).toContain("could not assemble the upload");
    expect(fetches.map((call) => call.url)).toEqual([
      "https://r2.example/complete",
      "https://r2.example/abort",
    ]);
  });

  it("swallows an abort that itself fails, so the original error is what surfaces", async () => {
    outcomes = [{ kind: "status", status: 403, statusText: "Forbidden" }];
    fetchImpl = (url) => {
      if (url.endsWith("/abort")) {
        throw new Error("abort endpoint down");
      }

      return new Response("", { status: 200 });
    };

    const error = await rejection(uploadFileToPresign(fakeFile(1024), presignFor(1)));

    expect(messageOf(error)).toContain("R2 rejected the part (403");
  });

  it("abortMultipart DELETEs the presigned URL", async () => {
    await abortMultipart("https://r2.example/abort");

    expect(fetches).toEqual([{ method: "DELETE", url: "https://r2.example/abort" }]);
  });
});

describe("presignRecordingUpload", () => {
  it("posts the part count to the admin route with the session cookie", async () => {
    const body = presignFor(2);

    fetchImpl = () => new Response(JSON.stringify(body), { status: 200 });

    await expect(presignRecordingUpload("rec 1", 2, "video/mp4")).resolves.toEqual(body);
    // The id rides in the PATH, so it must be encoded — an unescaped id would silently
    // address a different recording.
    expect(fetches[0]?.url).toBe("/api/v1/admin/recordings/rec%201/set-video/presign");
  });

  it("surfaces the server's error text rather than a bare status", async () => {
    fetchImpl = () => new Response("recording is already published", { status: 409 });

    await expect(presignRecordingUpload("rec_1", 2, "video/mp4")).rejects.toThrow(
      "recording is already published",
    );
  });
});

describe("isAbortError", () => {
  it("is true only for an AbortError DOMException", () => {
    expect(isAbortError(new DOMException("Upload aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("nope", "NotFoundError"))).toBe(false);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
    expect(isAbortError(new PermanentUploadError("nope"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

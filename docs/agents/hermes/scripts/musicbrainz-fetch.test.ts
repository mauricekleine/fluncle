import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  CRAWL_FETCH_OFFSET_SLOT,
  MB_MAX_BODY_BYTES,
  MB_MIN_REQUEST_INTERVAL_MS,
  MB_USER_AGENT,
  deferMusicbrainzBudget,
  fetchMusicbrainz,
  musicbrainzStateDir,
  reserveMusicbrainzSlot,
  runCrawlFetchPlan,
} from "./musicbrainz-fetch";

const WORKER_CLIENT = resolve(
  import.meta.dirname,
  "../../../../apps/web/src/lib/server/musicbrainz.ts",
);

let stateDir: string;

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to reject");
}

function askedUrl(input: Request | URL | string): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "fluncle-mb-budget-"));
});

afterEach(() => {
  rmSync(stateDir, { force: true, recursive: true });
});

describe("the box's MusicBrainz identity", () => {
  it("sends the same User-Agent the Worker sends", () => {
    const worker = readFileSync(WORKER_CLIENT, "utf8");
    expect(worker).toContain(`export const MB_USER_AGENT = "${MB_USER_AGENT}";`);
  });

  it("identifies itself on every request", async () => {
    const seen: (HeadersInit | undefined)[] = [];
    await fetchMusicbrainz("https://musicbrainz.org/ws/2/release/x?fmt=json", {
      fetch: (_url, init) => {
        seen.push(init?.headers);
        return Promise.resolve(jsonResponse({ id: "x" }));
      },
      intervalMs: 0,
      stateDir,
    });
    expect(seen).toHaveLength(1);
    expect((seen[0] as Record<string, string>)["User-Agent"]).toBe(MB_USER_AGENT);
  });

  it("refuses a url outside MusicBrainz", async () => {
    expect(
      await rejection(
        fetchMusicbrainz("https://example.com/ws/2/release/x", { intervalMs: 0, stateDir }),
      ),
    ).toMatch(/outside MusicBrainz/);
    expect(
      await rejection(
        fetchMusicbrainz("http://musicbrainz.org/ws/2/release/x", { intervalMs: 0, stateDir }),
      ),
    ).toMatch(/outside MusicBrainz/);
  });
});

describe("the one shared rate budget", () => {
  it("paces reservations taken in one process", async () => {
    const first = await reserveMusicbrainzSlot(stateDir, 40);
    const second = await reserveMusicbrainzSlot(stateDir, 40);
    expect(second - first).toBeGreaterThanOrEqual(40);
  });

  it("paces reservations taken by CONCURRENT PROCESSES", async () => {
    const interval = 120;
    const runner = join(stateDir, "reserve.ts");
    writeFileSync(
      runner,
      [
        `import { reserveMusicbrainzSlot } from ${JSON.stringify(resolve(import.meta.dirname, "musicbrainz-fetch.ts"))};`,
        `const slot = await reserveMusicbrainzSlot(${JSON.stringify(stateDir)}, ${interval});`,
        "console.log(String(slot));",
      ].join("\n"),
    );

    const slots = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<number>((resolvePromise, rejectPromise) => {
            const child = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] });
            let out = "";
            let err = "";
            child.stdout.on("data", (chunk: Buffer) => {
              out += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              err += chunk.toString();
            });
            child.on("close", (code) =>
              code === 0
                ? resolvePromise(Number(out.trim()))
                : rejectPromise(new Error(`reserve exited ${code}: ${err}`)),
            );
          }),
      ),
    );

    const ordered = [...slots].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1] ?? 0;
      const current = ordered[index] ?? 0;
      expect(current - previous).toBeGreaterThanOrEqual(interval);
    }
  }, 20_000);

  it("pushes every caller's next slot forward on a Retry-After", async () => {
    await deferMusicbrainzBudget(5_000, stateDir);
    const budget: { nextAllowedAtMs: number } = JSON.parse(
      readFileSync(join(stateDir, "budget.json"), "utf8"),
    );
    expect(budget.nextAllowedAtMs).toBeGreaterThan(Date.now() + 4_000);
  });

  it("honours a 503's Retry-After for the whole box and reports the exhausted throttle", async () => {
    let calls = 0;
    const outcomes: string[] = [];
    const result = await fetchMusicbrainz("https://musicbrainz.org/ws/2/release/x?fmt=json", {
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response("", { headers: { "Retry-After": "0" }, status: 503 }));
      },
      intervalMs: 0,
      onAttempt: ({ outcome }) => outcomes.push(outcome),
      stateDir,
    });

    expect(result).toEqual({ outcome: "throttled", url: expect.any(String) });
    expect(calls).toBe(3);
    expect(outcomes).toEqual(["retry_503", "retry_503", "throttled"]);
  });

  it("defaults its state dir to the sweep home so every sibling shares one budget", () => {
    expect(musicbrainzStateDir().endsWith("/.musicbrainz")).toBe(true);
    expect(MB_MIN_REQUEST_INTERVAL_MS).toBe(1_100);
  });
});

describe("what one read comes back as", () => {
  const read = (response: Response) =>
    fetchMusicbrainz("https://musicbrainz.org/ws/2/release/x?fmt=json", {
      fetch: () => Promise.resolve(response),
      intervalMs: 0,
      stateDir,
    });

  it("reports a body", async () => {
    expect(await read(jsonResponse({ id: "x" }))).toMatchObject({
      body: { id: "x" },
      outcome: "body",
    });
  });

  it("reports a non-ok status as empty, exactly as a Worker fetch swallows it", async () => {
    expect(await read(new Response("", { status: 404 }))).toMatchObject({ outcome: "empty" });
  });

  it("reports a body that is not JSON", async () => {
    expect(await read(new Response("not json at all", { status: 200 }))).toMatchObject({
      outcome: "invalid",
    });
  });

  it("reports a body past the signed envelope's bound", async () => {
    const huge = new Response(JSON.stringify({ pad: "x".repeat(MB_MAX_BODY_BYTES) }), {
      status: 200,
    });
    expect(await read(huge)).toMatchObject({ outcome: "oversize" });
  });

  it("never follows a redirect off the pinned host", async () => {
    const inits: (RequestInit | undefined)[] = [];
    for (const status of [301, 302, 307, 308]) {
      const result = await fetchMusicbrainz("https://musicbrainz.org/ws/2/release/x?fmt=json", {
        fetch: (_url, init) => {
          inits.push(init);
          return Promise.resolve(
            new Response("", { headers: { Location: "http://169.254.169.254/" }, status }),
          );
        },
        intervalMs: 0,
        stateDir,
      });
      expect(result, String(status)).toEqual({ outcome: "empty", url: expect.any(String) });
    }
    expect(inits).toHaveLength(4);
    for (const init of inits) {
      expect(init?.redirect).toBe("manual");
    }
  });

  it("reports a network error as empty rather than a throttle", async () => {
    expect(
      await fetchMusicbrainz("https://musicbrainz.org/ws/2/release/x?fmt=json", {
        fetch: () => Promise.reject(new Error("socket closed")),
        intervalMs: 0,
        stateDir,
      }),
    ).toMatchObject({ outcome: "empty" });
  });
});

describe("the issued fetch plan", () => {
  const tail = {
    countField: "release-count" as const,
    kind: "tail" as const,
    pageSize: 100,
    pageUrlTemplate: `https://musicbrainz.org/ws/2/release?artist=a&limit=100&offset=${CRAWL_FETCH_OFFSET_SLOT}&fmt=json`,
    probeUrl: "https://musicbrainz.org/ws/2/release?artist=a&limit=1&offset=0&fmt=json",
  };

  it("makes no request at all for a node whose provider leg reads nothing", async () => {
    expect(await runCrawlFetchPlan({ kind: "none" }, { stateDir })).toEqual([]);
  });

  it("pages a browse tail from the probe's count", async () => {
    const asked: string[] = [];
    const supplied = await runCrawlFetchPlan(tail, {
      fetch: (url) => {
        asked.push(askedUrl(url));
        return Promise.resolve(jsonResponse({ "release-count": 250, releases: [] }));
      },
      intervalMs: 0,
      stateDir,
    });
    expect(asked).toEqual([
      tail.probeUrl,
      "https://musicbrainz.org/ws/2/release?artist=a&limit=100&offset=150&fmt=json",
    ]);
    expect(supplied).toHaveLength(2);
  });

  it("stops at the probe when the browse list is empty", async () => {
    const asked: string[] = [];
    const supplied = await runCrawlFetchPlan(tail, {
      fetch: (url) => {
        asked.push(askedUrl(url));
        return Promise.resolve(jsonResponse({ "release-count": 0, releases: [] }));
      },
      intervalMs: 0,
      stateDir,
    });
    expect(asked).toEqual([tail.probeUrl]);
    expect(supplied).toHaveLength(1);
  });

  it("stops at the probe when the vendor throttled it", async () => {
    const supplied = await runCrawlFetchPlan(tail, {
      fetch: () =>
        Promise.resolve(new Response("", { headers: { "Retry-After": "0" }, status: 503 })),
      intervalMs: 0,
      stateDir,
    });
    expect(supplied).toEqual([{ outcome: "throttled", url: tail.probeUrl }]);
  });
});

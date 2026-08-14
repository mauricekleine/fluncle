import { afterEach, describe, expect, it, vi } from "vitest";
import { FOUND_BASE } from "../media";
import { readCaptions } from "./captions";

// The admin board's caption preload. Its contract is narrow but load-bearing on a surface
// that cannot retry: the operator's copy tap must have the text already in hand, so every
// way a bundle can fail to answer has to resolve to an OMITTED key rather than a throw or
// an empty string the board would paste. `fetch` is stubbed — the suite never leaves the
// process (see src/test/block-network.ts).

/** Stub `fetch` with a per-URL answer; anything unlisted 404s. `readCaptions` fetches by URL string. */
function stubBundles(answers: Record<string, Response | (() => Response)>) {
  const fetchMock = vi.fn((url: string) => {
    const answer = answers[url];

    if (!answer) {
      return Promise.resolve(new Response("", { status: 404 }));
    }

    return Promise.resolve(typeof answer === "function" ? answer() : answer);
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

const noteUrl = (logId: string): string => `${FOUND_BASE}/${encodeURIComponent(logId)}/note.txt`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readCaptions", () => {
  it("short-circuits an empty id list without touching the network", async () => {
    const fetchMock = stubBundles({});

    await expect(readCaptions([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keys each bundle's caption by its Log ID", async () => {
    stubBundles({
      [noteUrl("004.7.2I")]: new Response("Rolls like a corridor."),
      [noteUrl("005.9.9L")]: new Response("Half-time, all weight."),
    });

    await expect(readCaptions(["004.7.2I", "005.9.9L"])).resolves.toEqual({
      "004.7.2I": "Rolls like a corridor.",
      "005.9.9L": "Half-time, all weight.",
    });
  });

  it("trims the stored caption", async () => {
    stubBundles({ [noteUrl("004.7.2I")]: new Response("  Rolls like a corridor.\n\n") });

    await expect(readCaptions(["004.7.2I"])).resolves.toEqual({
      "004.7.2I": "Rolls like a corridor.",
    });
  });

  it("percent-encodes the Log ID into the bundle path", async () => {
    const fetchMock = stubBundles({});

    await readCaptions(["004.7.2I?x"]);

    expect(fetchMock).toHaveBeenCalledWith(`${FOUND_BASE}/004.7.2I%3Fx/note.txt`);
  });

  it("omits a missing bundle rather than storing an empty caption", async () => {
    stubBundles({ [noteUrl("004.7.2I")]: new Response("", { status: 404 }) });

    await expect(readCaptions(["004.7.2I"])).resolves.toEqual({});
  });

  it("omits a whitespace-only caption", async () => {
    // An empty key would paste nothing on the operator's tap, which reads as a bug in the
    // clipboard rather than an absent caption. Absent is the honest answer.
    stubBundles({ [noteUrl("004.7.2I")]: new Response("   \n  ") });

    await expect(readCaptions(["004.7.2I"])).resolves.toEqual({});
  });

  it("omits a bundle whose fetch throws, and still returns its siblings", async () => {
    stubBundles({
      [noteUrl("004.7.2I")]: () => {
        throw new Error("network down");
      },
      [noteUrl("005.9.9L")]: new Response("Half-time, all weight."),
    });

    await expect(readCaptions(["004.7.2I", "005.9.9L"])).resolves.toEqual({
      "005.9.9L": "Half-time, all weight.",
    });
  });

  it("reads the bundles in parallel — one fetch per id, all in flight together", async () => {
    const logIds = ["004.7.2I", "005.9.9L", "006.1.0A"];
    let inFlight = 0;
    let peak = 0;

    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield so a sequential implementation would settle this call before the next starts.
      await Promise.resolve();
      inFlight -= 1;

      return new Response("a caption");
    });

    vi.stubGlobal("fetch", fetchMock);

    await readCaptions(logIds);

    expect(fetchMock).toHaveBeenCalledTimes(logIds.length);
    expect(peak).toBe(logIds.length);
  });
});

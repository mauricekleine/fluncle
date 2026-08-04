import { describe, expect, test } from "bun:test";

import {
  DEEZER_QUOTA_ABORT_STREAK,
  ISRC_RECOVERY_EXPECTED_INTERVAL_MS,
  ISRC_RECOVERY_PACE_MS,
  runIsrcRecoveryCli,
  searchDeezerCandidates,
  type RuntimeEffects,
} from "./isrc-recovery-sweep";

const HIT = {
  artist: { name: "Calibre" },
  duration: 132,
  id: 123,
  isrc: "GBEXH1900314",
  title: "Mr Right On",
};

type FetchCall = { body?: string; method: string; url: string };

function requestBody(init?: RequestInit): string {
  return typeof init?.body === "string" ? init.body : "{}";
}

function effects(
  request: (url: string, init?: RequestInit) => Promise<Response>,
  options: { batch?: string } = {},
): {
  calls: FetchCall[];
  effects: RuntimeEffects;
  logs: string[];
  output: string[];
  sleeps: number[];
} {
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  const output: string[] = [];
  const sleeps: number[] = [];

  return {
    calls,
    effects: {
      env: {
        FLUNCLE_API_BASE_URL: "https://worker.example",
        FLUNCLE_API_TOKEN: "agent-token",
        ...(options.batch ? { FLUNCLE_ISRC_RECOVERY_BATCH: options.batch } : {}),
      },
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
          method: init?.method ?? "GET",
          url,
        });
        return request(url, init);
      }) as typeof fetch,
      log: (message) => logs.push(message),
      output: (line) => output.push(line),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
    logs,
    output,
    sleeps,
  };
}

function queue(rows: { deezerQuery: string; trackId: string }[], queued = rows.length): Response {
  return Response.json({ queued, tracks: rows });
}

describe("isrc-recovery sweep", () => {
  test("recovers through resolve_anchor with the server query and spotifySearch false", async () => {
    const harness = effects((url, init) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(
          queue(
            [
              { deezerQuery: 'artist:"Calibre" track:"Mr Right On"', trackId: "mb_recover" },
              { deezerQuery: 'artist:"A" track:"B"', trackId: "mb_empty" },
            ],
            10,
          ),
        );
      }
      if (url.includes("api.deezer.com") && url.includes("Calibre")) {
        return Promise.resolve(Response.json({ data: [HIT] }));
      }
      if (url.includes("api.deezer.com")) {
        return Promise.resolve(Response.json({ data: [] }));
      }
      if (url.endsWith("/api/v1/admin/catalogue/anchor/resolve")) {
        const body = JSON.parse(requestBody(init)) as { deezerCandidates?: unknown[] };
        return Promise.resolve(
          Response.json({ isrcRecoveredByDeezer: (body.deezerCandidates?.length ?? 0) > 0 }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const result = await runIsrcRecoveryCli([], harness.effects);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatchObject({
      checked: 2,
      deezerEmpty: 1,
      errors: 0,
      produced: 1,
      queueDepth: 8,
      recovered: 1,
    });

    const deezerCall = harness.calls.find((call) => call.url.includes("api.deezer.com"));
    expect(decodeURIComponent(deezerCall?.url ?? "")).toContain(
      'q=artist:"Calibre" track:"Mr Right On"&limit=5',
    );

    const resolveCalls = harness.calls.filter((call) => call.url.endsWith("/anchor/resolve"));
    expect(resolveCalls.length).toBe(2);
    expect(JSON.parse(resolveCalls[0]?.body ?? "{}")).toEqual({
      deezerCandidates: [
        {
          artistName: "Calibre",
          deezerTrackId: "123",
          durationMs: 132_000,
          isrc: "GBEXH1900314",
          title: "Mr Right On",
        },
      ],
      spotifySearch: false,
      trackId: "mb_recover",
    });
    expect(harness.calls.some((call) => call.url.endsWith("/admin/catalogue/anchor"))).toBe(false);
    expect(harness.sleeps).toEqual([ISRC_RECOVERY_PACE_MS]);
    expect(harness.output.length).toBe(1);
    expect(JSON.parse(harness.output[0] ?? "{}")).toEqual(result.summary);
  });

  test("separates gate refusals, genuine empty results, and failed error bodies", async () => {
    const harness = effects((url, init) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(
          queue(
            [
              { deezerQuery: "candidate", trackId: "mb_refused" },
              { deezerQuery: "empty-data", trackId: "mb_empty_data" },
              { deezerQuery: "incomplete", trackId: "mb_incomplete" },
              { deezerQuery: "empty-code", trackId: "mb_empty_code" },
            ],
            7,
          ),
        );
      }
      if (url.includes("api.deezer.com") && url.includes("candidate")) {
        return Promise.resolve(Response.json({ data: [HIT] }));
      }
      if (url.includes("api.deezer.com") && url.includes("empty-code")) {
        return Promise.resolve(Response.json({ error: { code: 800, message: "no data" } }));
      }
      if (url.includes("api.deezer.com") && url.includes("incomplete")) {
        return Promise.resolve(Response.json({ data: [{ ...HIT, isrc: "" }] }));
      }
      if (url.includes("api.deezer.com")) {
        return Promise.resolve(Response.json({ data: [] }));
      }
      if (url.endsWith("/anchor/resolve")) {
        const body = JSON.parse(requestBody(init)) as {
          deezerCandidates?: unknown[];
          trackId?: string;
        };
        expect(Array.isArray(body.deezerCandidates)).toBe(true);
        return Promise.resolve(
          Response.json({
            anchored: body.trackId === "mb_empty_data",
            isrcRecoveredByDeezer: false,
          }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const { summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(summary).toMatchObject({
      checked: 4,
      deezerEmpty: 1,
      deezerHitsDroppedIncomplete: 1,
      errors: 0,
      failed: 1,
      gateRefused: 1,
      produced: 0,
      queueDepth: 4,
      recovered: 0,
      transportFailed: 1,
    });
  });

  test("retries explicit quota bodies and aborts the remainder after the quota streak", async () => {
    let deezerCalls = 0;
    const rows = Array.from({ length: 5 }, (_, index) => ({
      deezerQuery: `q-${index}`,
      trackId: `mb_${index}`,
    }));
    const harness = effects((url) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(queue(rows, 20));
      }
      if (url.includes("api.deezer.com")) {
        deezerCalls += 1;
        return Promise.resolve(
          Response.json({ error: { code: 4, message: "Quota limit exceeded" } }),
        );
      }
      return Promise.resolve(new Response("resolve must not run", { status: 500 }));
    });

    const { summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(DEEZER_QUOTA_ABORT_STREAK).toBe(3);
    expect(deezerCalls).toBe(9);
    expect(summary).toMatchObject({
      checked: 3,
      deezerEmpty: 0,
      errors: 0,
      gateRefused: 0,
      produced: 0,
      queueDepth: 20,
      quotaBlocked: 5,
      recovered: 0,
      transportFailed: 0,
    });
    expect(harness.calls.some((call) => call.url.endsWith("/anchor/resolve"))).toBe(false);
    expect(harness.sleeps.filter((ms) => ms === ISRC_RECOVERY_PACE_MS).length).toBe(2);
    expect(harness.sleeps.filter((ms) => ms === 1_200).length).toBe(3);
    expect(harness.sleeps.filter((ms) => ms === 2_500).length).toBe(3);
    expect(harness.logs.some((line) => line.includes("aborting after 3"))).toBe(true);
  });

  test("counts Deezer and resolve transport failures without collapsing them into empty", async () => {
    const harness = effects((url) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(
          queue([
            { deezerQuery: "network", trackId: "mb_network" },
            { deezerQuery: "resolve", trackId: "mb_resolve" },
          ]),
        );
      }
      if (url.includes("api.deezer.com") && url.includes("network")) {
        return Promise.reject(new Error("socket closed"));
      }
      if (url.includes("api.deezer.com")) {
        return Promise.resolve(Response.json({ data: [HIT] }));
      }
      if (url.endsWith("/anchor/resolve")) {
        return Promise.resolve(new Response("worker unavailable", { status: 503 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const { summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(summary).toMatchObject({
      checked: 2,
      deezerEmpty: 0,
      errors: 0,
      failed: 2,
      gateRefused: 0,
      queueDepth: 2,
      recovered: 0,
      transportFailed: 2,
    });
    const resolveCalls = harness.calls.filter((call) => call.url.endsWith("/anchor/resolve"));
    expect(resolveCalls).toHaveLength(1);
    expect(JSON.parse(resolveCalls[0]?.body ?? "{}").trackId).toBe("mb_resolve");
  });

  test("caps candidates at five before resolve_anchor", async () => {
    const harness = effects((url, init) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(queue([{ deezerQuery: "many", trackId: "mb_many" }]));
      }
      if (url.includes("api.deezer.com")) {
        return Promise.resolve(
          Response.json({
            data: Array.from({ length: 6 }, (_, index) => ({
              ...HIT,
              id: index,
              isrc: `GBEXH190031${index}`,
            })),
          }),
        );
      }
      if (url.endsWith("/anchor/resolve")) {
        const body = JSON.parse(requestBody(init)) as { deezerCandidates?: unknown[] };
        expect(body.deezerCandidates?.length).toBe(5);
        return Promise.resolve(Response.json({ isrcRecoveredByDeezer: false }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const { summary } = await runIsrcRecoveryCli([], harness.effects);
    expect(summary.gateRefused).toBe(1);
  });

  test("emits numeric run-ledger fields and honors the batch env", async () => {
    const harness = effects(
      (url) => {
        if (url.includes("/tracks/work?")) {
          return Promise.resolve(queue([], 12));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      },
      { batch: "77" },
    );

    const { summary } = await runIsrcRecoveryCli([], harness.effects);
    const queueCall = harness.calls.find((call) => call.url.includes("/tracks/work?"));

    expect(queueCall?.url).toContain("kind=isrc-recovery&limit=77&count=true");
    expect(summary.expectedIntervalMs).toBe(ISRC_RECOVERY_EXPECTED_INTERVAL_MS);
    for (const field of ["checked", "errors", "expectedIntervalMs", "produced", "queueDepth"]) {
      expect(typeof summary[field as keyof typeof summary]).toBe("number");
    }
    expect(harness.output.length).toBe(1);
  });
});

describe("searchDeezerCandidates", () => {
  test("treats non-quota error bodies and malformed result bodies as transport failures", async () => {
    for (const response of [
      Response.json({ error: { code: 123 } }),
      Response.json({ error: { code: 800 } }),
      Response.json({ nope: [] }),
      new Response("bad json"),
      new Response("down", { status: 503 }),
    ]) {
      const result = await searchDeezerCandidates(
        "q",
        {
          fetch: (() => Promise.resolve(response)) as typeof fetch,
          sleep: () => Promise.resolve(),
        },
        [],
      );
      expect(result.outcome).toBe("transport-failed");
    }
  });
});

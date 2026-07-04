// Fluncle LIVE — "the glass" (show-usable live runtime). The thin Bun server:
// bundles the browser client, serves the self-contained page, and exposes /plan +
// /scene (same-origin, no CORS). The renderer, the DSP, the flash limiter, the
// bridge client and the reliability rails live in ./client (bundled); the pure math
// (flash-limiter.ts, scene-extract.ts) is imported here and unit-tested.
//
// Run:  bun run glass   then open  http://localhost:4173
// Port: $FLUNCLE_GLASS_PORT overrides 4173 (the operator's live instance may hold it).
//
// Keys (operator cheat-sheet):
//   →/n advance · ←/p rewind · 0 holding · b blackout(hold) · -/= intensity
//   1/2/3 vehicle · m auto · v replay · g bloom · r scale · h HUD · d demo
//   l low-latency DSP (A/B) · Shift+X context-loss smoke
import { GLASS_PORT } from "../contract.ts";
import { renderPage } from "./page.ts";
import { buildPlan, logSummary } from "./plan.ts";

const port = Number(process.env.FLUNCLE_GLASS_PORT ?? GLASS_PORT);

// Bundle the browser client ONCE at boot (dev-fast; re-run to pick up edits).
async function bundleClient(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [new URL("./client/main.ts", import.meta.url).pathname],
    minify: false,
    target: "browser",
  });
  if (!built.success) {
    for (const log of built.logs) {
      console.error(log);
    }
    throw new Error("client bundle failed");
  }
  return await built.outputs[0].text();
}

const clientJs = await bundleClient();
const PAGE = renderPage(clientJs);

Bun.serve({
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/plan") {
      return Response.json(await buildPlan());
    }
    if (url.pathname === "/scene") {
      const logId = url.searchParams.get("logId") ?? "";
      const plan = await buildPlan();
      const e = plan.find((p) => p.logId === logId);
      return Response.json(
        e?.replay ?? { customUniforms: [], layers: [], reason: "unknown logId", replayable: false },
      );
    }
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  port,
});

console.log(
  `Fluncle LIVE — the glass → http://localhost:${port}\n` +
    "  →/n advance · ←/p rewind · 0 holding · b blackout(hold) · -/= intensity · 1/2/3 vehicle · m auto · v replay · g bloom · r scale · h HUD · d demo · l low-latency DSP · Shift+X smoke",
);

// Pre-extract every scene at boot and print the replayability table.
buildPlan()
  .then(logSummary)
  .catch((e) => console.error("plan/extract failed:", e));

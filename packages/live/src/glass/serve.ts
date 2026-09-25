import { BRIDGE_PORT, GLASS_PORT } from "../contract.ts";
import { legendLine } from "./keybindings.ts";
import { renderPage } from "./page.ts";
import {
  buildPlan,
  choosePlanSource,
  logSummary,
  type PlanEntry,
  type PlanSource,
  resolveBridgePlan,
  resolveBridgePlanWithRetry,
} from "./plan.ts";

const port = Number(process.env.FLUNCLE_GLASS_PORT ?? GLASS_PORT);

const bridgePort = Number(process.env.FLUNCLE_BRIDGE_PORT ?? BRIDGE_PORT);

let loggedPlanSource: PlanSource | null = null;

async function livePlan(): Promise<{ plan: PlanEntry[]; source: PlanSource }> {
  const bridgePlan = await resolveBridgePlan(bridgePort);

  const local = bridgePlan ? [] : await buildPlan();
  const picked = choosePlanSource(bridgePlan, local);
  if (loggedPlanSource !== picked.source) {
    loggedPlanSource = picked.source;
    console.log(picked.log);
  }
  return { plan: picked.plan, source: picked.source };
}

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
      const { plan, source } = await livePlan();

      return Response.json(plan, { headers: { "x-plan-source": source } });
    }
    if (url.pathname === "/scene") {
      const logId = url.searchParams.get("logId") ?? "";
      const { plan } = await livePlan();
      const e = plan.find((p) => p.logId === logId);
      return Response.json(
        e?.replay ?? {
          customUniforms: [],
          layers: [],
          reason: "unknown logId",
          replayable: false,
          textures: [],
          usesDrop: false,
        },
      );
    }
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  port,
});

console.log(`Fluncle LIVE — the glass → http://localhost:${port}\n  ${legendLine()}`);

resolveBridgePlanWithRetry(bridgePort)
  .then(async (bridgePlan) => {
    const local = bridgePlan ? [] : await buildPlan();
    const picked = choosePlanSource(bridgePlan, local);
    loggedPlanSource = picked.source;
    console.log(picked.log);
    logSummary(picked.plan);
  })
  .catch((e) => console.error("plan/extract failed:", e));

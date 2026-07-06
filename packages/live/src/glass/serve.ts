// Fluncle LIVE — "the glass" (show-usable live runtime). The thin Bun server:
// bundles the browser client, serves the self-contained page, and exposes /plan +
// /scene (same-origin, no CORS). The renderer, the DSP, the flash limiter, the
// bridge client and the reliability rails live in ./client (bundled); the pure math
// (flash-limiter.ts, scene-extract.ts) is imported here and unit-tested.
//
// Run:  bun run glass   then open  http://localhost:4173
// Port: $FLUNCLE_GLASS_PORT overrides 4173 (the operator's live instance may hold it).
//
// The operator cheat-sheet is generated from the ONE keybindings table (keybindings.ts)
// — the same table drives the keydown dispatch and the in-glass `i` legend overlay, so
// the boot line below can never drift from the behaviour.
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
// The bridge the glass resolves its /plan from (default :4180). Overridable so a test rig
// can point the glass at a scratch bridge without touching the operator's live :4180.
const bridgePort = Number(process.env.FLUNCLE_BRIDGE_PORT ?? BRIDGE_PORT);

// Narrate a change of plan source once (a bridge that appears / vanishes mid-show leaves a
// trail), not on every /plan poll.
let loggedPlanSource: PlanSource | null = null;

/**
 * The glass's live plan, resolved bridge-first: the bridge's /plan when it is up (the
 * operator's real plan WINS), else the local fixture floor. This is what BOTH /plan and
 * /scene read, so the pointer and the scene index the same list end-to-end.
 */
async function livePlan(): Promise<{ plan: PlanEntry[]; source: PlanSource }> {
  const bridgePlan = await resolveBridgePlan(bridgePort);
  // Only build the local plan when the bridge didn't answer — no wasted R2 fetches when it did.
  const local = bridgePlan ? [] : await buildPlan();
  const picked = choosePlanSource(bridgePlan, local);
  if (loggedPlanSource !== picked.source) {
    loggedPlanSource = picked.source;
    console.log(picked.log);
  }
  return { plan: picked.plan, source: picked.source };
}

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
      const { plan, source } = await livePlan();
      // The client narrates the winning source from this header (it fetches same-origin).
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

// Resolve the plan bridge-first at boot (brief retry window — `run show` raises the bridge
// first), then print the winner + the replayability table of whatever the glass will
// actually serve — so the boot table can never again show the local fixture while the
// bridge holds the real plan (the first-set debrief symptom).
resolveBridgePlanWithRetry(bridgePort)
  .then(async (bridgePlan) => {
    const local = bridgePlan ? [] : await buildPlan();
    const picked = choosePlanSource(bridgePlan, local);
    loggedPlanSource = picked.source;
    console.log(picked.log);
    logSummary(picked.plan);
  })
  .catch((e) => console.error("plan/extract failed:", e));

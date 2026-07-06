// pulse-lite server routes. Two actions prove the two feature paths every unit
// builds on: a plain action (POST notify → osascript, the windowless tap on the
// shoulder) and a streamed action (POST ping → runStreamed, read live over SSE
// in the run drawer, pre-flight tokens included).

import { type RunStartedResponse } from "../../contract";
import { json } from "../../server/features";
import { type HelmApp } from "../types";

// The line check: a tiny spawned child that narrates the action-streaming path
// in the pre-flight vocabulary ([clear]/[hold]/[dark], packages/live/src/show.ts).
const LINE_CHECK_SCRIPT = [
  'echo "line check — the helm sounds its own wiring"',
  "sleep 0.4",
  'echo "  [clear] spawn                  a child ran under the daemon"',
  "sleep 0.4",
  'echo "  [clear] stream                 you are reading it live"',
  "sleep 0.4",
  'echo "  [clear] line check             the wiring holds"',
].join("\n");

export function registerRoutes(app: HelmApp): void {
  app.post("/api/pulse-lite/notify", async (req) => {
    const body = await readJsonBody(req);
    const title = readString(body, "title") ?? "Fluncle's Helm";
    const text = readString(body, "body") ?? "The helm holds. This is what a nudge feels like.";

    await app.context.notify(title, text);

    return json({ ok: true });
  });

  app.post("/api/pulse-lite/ping", () => {
    const { runId } = app.context.runs.runStreamed(["/bin/sh", "-c", LINE_CHECK_SCRIPT], {
      feature: "pulse-lite",
      title: "line check",
    });
    const body: RunStartedResponse = { runId };

    return json(body);
  });
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[key];

  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

// Feature loading, daemon side. For every id in the registry (src/features/
// index.ts) import its manifest + server module by convention and let it register
// its /api/<id>/… routes. The per-run stream/kill routes are mounted ONCE here for
// all features — a feature's server.ts only ever starts runs and answers actions.

import { RUN_SSE_LINE_EVENT, RUN_SSE_STATUS_EVENT } from "../contract";
import { featureAllowedOnMachine } from "../features/gating";
import { featureIds } from "../features/index";
import { type FeatureManifest, type HelmApp, type RegisterRoutes } from "../features/types";
import { type Router } from "./router";
import { type RunEvent } from "./runs";
import { SSE_HEADERS, sseComment, sseEvent } from "./sse";

const SSE_KEEPALIVE_MS = 15_000;

/**
 * The app a feature registers against. Reads (GET) stay open everywhere; action
 * POSTs from a feature whose manifest excludes this machine answer 403 — the
 * panel gate (visibleFeatures) enforced SERVER-SIDE, so a request aimed straight
 * at the API meets the same wall as one from a hidden panel.
 */
export function machineGatedApp(app: HelmApp, manifest: FeatureManifest): HelmApp {
  if (featureAllowedOnMachine(manifest, app.context.machine)) {
    return app;
  }

  return {
    context: app.context,
    get(pattern, handler) {
      app.get(pattern, handler);
    },
    post(pattern) {
      app.post(pattern, () =>
        json(
          {
            code: "wrong_machine",
            message: `The ${manifest.title} station holds on ${manifest.machines.join("/")} — not this Mac.`,
          },
          403,
        ),
      );
    },
  };
}

export async function registerFeatures(app: HelmApp): Promise<FeatureManifest[]> {
  const manifests: FeatureManifest[] = [];

  for (const id of featureIds) {
    const manifestModule = (await import(`../features/${id}/manifest.ts`)) as {
      manifest: FeatureManifest;
    };
    const { manifest } = manifestModule;

    if (manifest.id !== id) {
      throw new Error(`feature ${id}: manifest.id reads ${manifest.id} — they must match`);
    }

    manifests.push(manifest);

    const serverModule = (await import(`../features/${id}/server.ts`)) as {
      registerRoutes: RegisterRoutes;
    };
    serverModule.registerRoutes(machineGatedApp(app, manifest));
  }

  return manifests;
}

/**
 * The shared run routes every feature gets for free (the action-streaming
 * pattern): `GET /api/:feature/runs/:runId/stream` (SSE — buffered lines replayed,
 * then live, closed after the final status) and `POST /api/:feature/runs/:runId/kill`.
 */
export function registerRunRoutes(router: Router, app: HelmApp): void {
  router.add("GET", "/api/:feature/runs/:runId/stream", (req, params) => {
    const feature = params.feature ?? "";
    const runId = params.runId ?? "";
    const run = app.context.runs.get(feature, runId);

    if (!run) {
      return json({ code: "not_found", message: "No such run on this station." }, 404);
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let unsubscribe = (): void => {};
        let keepalive: ReturnType<typeof setInterval> | undefined;

        const close = (): void => {
          if (closed) {
            return;
          }

          closed = true;
          unsubscribe();

          if (keepalive !== undefined) {
            clearInterval(keepalive);
          }

          try {
            controller.close();
          } catch {
            // Already errored/cancelled by the client — nothing left to close.
          }
        };

        const send = (frame: string): void => {
          if (closed) {
            return;
          }

          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            close();
          }
        };

        // Replay the buffer, then go live. Subscribe FIRST so no line can fall
        // between the snapshot and the live tail; the seq guard drops replays.
        let lastSeq = -1;

        unsubscribe = app.context.runs.subscribe(feature, runId, (event: RunEvent) => {
          if (event.kind === "line") {
            if (event.line.seq <= lastSeq) {
              return;
            }

            lastSeq = event.line.seq;
            send(sseEvent(RUN_SSE_LINE_EVENT, event.line));
            return;
          }

          send(sseEvent(RUN_SSE_STATUS_EVENT, event.run));
          close();
        });

        for (const line of run.lines) {
          lastSeq = line.seq;
          send(sseEvent(RUN_SSE_LINE_EVENT, line));
        }

        // The run may have finished before this stream attached: emit the final
        // status straight away and be done.
        if (run.status !== "running") {
          send(
            sseEvent(RUN_SSE_STATUS_EVENT, {
              argv: run.argv,
              endedAt: run.endedAt,
              exitCode: run.exitCode,
              feature: run.feature,
              id: run.id,
              startedAt: run.startedAt,
              status: run.status,
              title: run.title,
            }),
          );
          close();
          return;
        }

        keepalive = setInterval(() => {
          send(sseComment("hold"));
        }, SSE_KEEPALIVE_MS);

        req.signal.addEventListener("abort", close);
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  });

  router.add("POST", "/api/:feature/runs/:runId/kill", (_req, params) => {
    const killed = app.context.runs.kill(params.feature ?? "", params.runId ?? "");

    if (!killed) {
      return json({ code: "not_found", message: "No running action under that id." }, 404);
    }

    return json({ ok: true });
  });
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

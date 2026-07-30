import { cronSurfaces } from "@fluncle/registry";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CRON_ORDER,
  INFRA_SERVICE_LABELS,
  INFRA_SERVICE_SUBTITLES,
  ServiceRow,
  SELF_POSTED_AUTOMATION_ORDER,
  SERVICE_ORDER,
  serviceCheckedAtLabel,
  serviceLabel,
  serviceSubtitle,
} from "./status";

// The /status board labels its rows two ways: a REGISTRY cron reads its title +
// one-line description from its @fluncle/registry surface (the single source of
// truth, guarded by the registry test), and a NON-registry infra probe (`web`, `db`,
// `r2`, … — short aliases that are not registry names) reads them from the explicit
// INFRA maps in status.tsx. This suite is the second guard the recurrence fix needs:
// a new infra probe can't slip onto the board unlabeled either.

// The service ids the board renders that are NOT registry surfaces — the core
// services + the self-posted automations. Each must carry an explicit infra label
// AND subtitle, or it would fall through to the raw-slug fallback.
const infraServiceIds = [...SERVICE_ORDER, ...SELF_POSTED_AUTOMATION_ORDER];

describe("/status label coverage", () => {
  it("every non-registry infra probe carries an explicit label + subtitle", () => {
    for (const id of infraServiceIds) {
      expect(INFRA_SERVICE_LABELS[id], `${id}: missing an infra label`).toBeTruthy();
      expect(INFRA_SERVICE_SUBTITLES[id], `${id}: missing an infra subtitle`).toBeTruthy();
      // serviceLabel resolves it to the explicit label, never the slug fallback.
      expect(serviceLabel(id)).toBe(INFRA_SERVICE_LABELS[id]);
      expect(serviceSubtitle(id)).toBe(INFRA_SERVICE_SUBTITLES[id]);
    }
  });

  it("every registry cron resolves its title + description from the registry", () => {
    for (const name of CRON_ORDER) {
      const label = serviceLabel(name);
      // A registry-backed title, not the `cron.`-stripped slug fallback.
      expect(label, `${name}: unlabeled`).toBeTruthy();
      expect(label).not.toBe(name.slice("cron.".length));
      expect(serviceSubtitle(name), `${name}: no description`).toBeTruthy();
    }
  });

  // Sonar arrives as TWO rows from two different posters, and which group each lands in
  // is the easy thing to get wrong: the healthcheck prober posts `sonar` (the engine's
  // own liveness — a running service), while the engine's freshen timer posts
  // `self-deploy-sonar` (a scheduled system — ops automation, beside `self-deploy-ssh`).
  it("sonar files as a service and its freshen timer as an ops automation", () => {
    expect(SERVICE_ORDER).toContain("sonar");
    expect(SELF_POSTED_AUTOMATION_ORDER).not.toContain("sonar");
    expect(CRON_ORDER).not.toContain("sonar");

    expect(SELF_POSTED_AUTOMATION_ORDER).toContain("self-deploy-sonar");
    expect(SERVICE_ORDER).not.toContain("self-deploy-sonar");

    expect(serviceLabel("sonar")).toBe("Sonar");
    expect(serviceSubtitle("sonar")).toBe("the sonic-similarity engine");
    expect(serviceLabel("self-deploy-sonar")).toBe("Self-deploy (sonar)");
    expect(serviceSubtitle("self-deploy-sonar")).toBe(
      "the engine pulls a new build when apps/sonar changes",
    );
  });

  it("the infra maps hold ONLY non-registry ids (no cron leaked in)", () => {
    const cronNames = new Set(cronSurfaces().map((surface) => surface.name));
    for (const id of Object.keys(INFRA_SERVICE_LABELS)) {
      expect(cronNames.has(id), `${id}: a registry cron must not be in the infra map`).toBe(false);
    }
  });
});

describe("/status report age", () => {
  it("renders a never-reported row's absence once without inventing a timestamp", () => {
    const now = "2026-07-30T12:00:00.000Z";
    const html = renderToStaticMarkup(
      createElement(ServiceRow, {
        now,
        samples: [],
        service: {
          checked_at: null,
          latency_ms: null,
          message: "never reported",
          service: "self-deploy-sonar",
          since: null,
          status: "degraded",
        },
      }),
    );

    expect(html.match(/never reported/g)).toHaveLength(1);
    expect(html).toContain("no history yet");
    expect(html).not.toContain("as of");
    expect(html).not.toContain("<time");
    expect(serviceCheckedAtLabel(now)).toBe("as of Jul 30, 12:00 UTC");
  });
});

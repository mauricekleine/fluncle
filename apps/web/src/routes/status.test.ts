import { cronSurfaces } from "@fluncle/registry";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getStatusCronConfig } from "@/lib/server/status";
import {
  INFRA_SERVICE_LABELS,
  INFRA_SERVICE_SUBTITLES,
  ServiceRow,
  SELF_POSTED_AUTOMATION_ORDER,
  SERVICE_ORDER,
  serviceCheckedAtLabel,
  serviceLabel,
  serviceSubtitle,
} from "./status";

const infraServiceIds = [...SERVICE_ORDER, ...SELF_POSTED_AUTOMATION_ORDER];
const cronConfig = getStatusCronConfig();

describe("/status label coverage", () => {
  it("every non-registry infra probe carries an explicit label + subtitle", () => {
    for (const id of infraServiceIds) {
      expect(INFRA_SERVICE_LABELS[id], `${id}: missing an infra label`).toBeTruthy();
      expect(INFRA_SERVICE_SUBTITLES[id], `${id}: missing an infra subtitle`).toBeTruthy();

      expect(serviceLabel(id, cronConfig)).toBe(INFRA_SERVICE_LABELS[id]);
      expect(serviceSubtitle(id, cronConfig)).toBe(INFRA_SERVICE_SUBTITLES[id]);
    }
  });

  it("every registry cron resolves its title + description from the registry", () => {
    const surfaces = cronSurfaces();
    expect(cronConfig.order).toEqual(surfaces.map((surface) => surface.name));

    for (const surface of surfaces) {
      const name = surface.name;
      const label = serviceLabel(name, cronConfig);

      expect(label).toBe(surface.title);
      expect(label).not.toBe(name.slice("cron.".length));
      expect(serviceSubtitle(name, cronConfig)).toBe(surface.statusDescription);
      expect(cronConfig.rows[name]?.cadenceMs).toBe(surface.probeConfig?.cadenceMs);
      expect(cronConfig.rows[name]?.schedule).toEqual(surface.probeConfig?.schedule);
    }

    expect(JSON.parse(JSON.stringify(cronConfig))).toEqual(cronConfig);
  });

  it("sonar files as a service and its freshen timer as an ops automation", () => {
    expect(SERVICE_ORDER).toContain("sonar");
    expect(SELF_POSTED_AUTOMATION_ORDER).not.toContain("sonar");
    expect(cronConfig.order).not.toContain("sonar");

    expect(SELF_POSTED_AUTOMATION_ORDER).toContain("self-deploy-sonar");
    expect(SERVICE_ORDER).not.toContain("self-deploy-sonar");

    expect(serviceLabel("sonar", cronConfig)).toBe("Sonar");
    expect(serviceSubtitle("sonar", cronConfig)).toBe("the sonic-similarity engine");
    expect(serviceLabel("self-deploy-sonar", cronConfig)).toBe("Self-deploy (sonar)");
    expect(serviceSubtitle("self-deploy-sonar", cronConfig)).toBe(
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
        cronConfig,
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

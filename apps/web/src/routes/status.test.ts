import { cronSurfaces } from "@fluncle/registry";
import { describe, expect, it } from "vitest";
import {
  CRON_ORDER,
  INFRA_SERVICE_LABELS,
  INFRA_SERVICE_SUBTITLES,
  SELF_POSTED_AUTOMATION_ORDER,
  SERVICE_ORDER,
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

  it("the infra maps hold ONLY non-registry ids (no cron leaked in)", () => {
    const cronNames = new Set(cronSurfaces().map((surface) => surface.name));
    for (const id of Object.keys(INFRA_SERVICE_LABELS)) {
      expect(cronNames.has(id), `${id}: a registry cron must not be in the infra map`).toBe(false);
    }
  });
});

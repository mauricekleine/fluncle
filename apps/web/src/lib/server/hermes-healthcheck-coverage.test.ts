import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SURFACES } from "@fluncle/registry";
import { describe, expect, it } from "vitest";

// The registry ↔ box-prober sync gate. Every `cron.*` surface in @fluncle/registry gets its
// /status row from the box healthcheck prober's hardcoded AUTOMATION_CRONS list
// (docs/agents/hermes/scripts/fluncle-healthcheck.ts) — the script runs baked on the box and
// cannot import the workspace, so the list is a hand-kept mirror. Hand-kept mirrors drift:
// cron.frontier-refresh and cron.cover-masters both shipped registered-but-unprobed (invisible
// on /status, found 2026-07-17). This test makes that drift a build failure instead of a quiet
// hole in the board.
//
// The one sanctioned asymmetry: cron.healthcheck is the prober ITSELF — it has no output dir to
// read (a self-read would be circular) and emits its own row via probeHealthcheck(), so it is
// deliberately absent from AUTOMATION_CRONS (documented inline there).

const HEALTHCHECK_PATH = join(
  __dirname,
  "../../../../../docs/agents/hermes/scripts/fluncle-healthcheck.ts",
);

/** `cron.*` service ids the prober emits rows for, parsed from its AUTOMATION_CRONS list. */
function proberCronServices(): Set<string> {
  const source = readFileSync(HEALTHCHECK_PATH, "utf8");
  return new Set([...source.matchAll(/service: "(cron\.[a-z-]+)"/g)].map((m) => m[1] ?? ""));
}

/** `cron.*` surface names registered in @fluncle/registry. */
function registryCronNames(): Set<string> {
  return new Set(
    SURFACES.filter((s) => s.kind === "cron" && s.name.startsWith("cron.")).map((s) => s.name),
  );
}

describe("the box healthcheck prober mirrors the registry's crons", () => {
  it("probes every registered cron (a registry cron missing here is invisible on /status)", () => {
    const prober = proberCronServices();
    const missing = [...registryCronNames()]
      .filter((name) => name !== "cron.healthcheck")
      .filter((name) => !prober.has(name))
      .sort();

    expect(missing).toEqual([]);
  });

  it("probes no retired cron (a prober entry without a registry surface is a ghost row)", () => {
    const registered = registryCronNames();
    const ghosts = [...proberCronServices()].filter((service) => !registered.has(service)).sort();

    expect(ghosts).toEqual([]);
  });
});

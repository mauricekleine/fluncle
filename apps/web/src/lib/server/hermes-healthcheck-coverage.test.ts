import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SURFACES } from "@fluncle/registry";
import { describe, expect, it } from "vitest";

const HEALTHCHECK_PATH = join(
  __dirname,
  "../../../../../docs/agents/hermes/scripts/fluncle-healthcheck.ts",
);

function proberCronServices(): Set<string> {
  const source = readFileSync(HEALTHCHECK_PATH, "utf8");
  return new Set([...source.matchAll(/service: "(cron\.[a-z-]+)"/g)].map((m) => m[1] ?? ""));
}

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

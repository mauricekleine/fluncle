import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_DIR = fileURLToPath(new URL("../../routes/api", import.meta.url));
const V1_DIR = `${API_DIR}/v1`;

const V1_ONLY_ROUTES = new Set([
  "follow-digest/unsubscribe",
  "openapi[.]json",
  "postman[.]json",
  "status",
]);

const BARE_ONLY_ROUTES = new Set(["og.set", "og.hub"]);

function listRouteFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...listRouteFiles(`${dir}/${entry.name}`, rel));
      continue;
    }

    if (
      !entry.name.endsWith(".ts") ||
      entry.name.startsWith("-") ||
      entry.name.includes(".test.")
    ) {
      continue;
    }

    out.push(rel.replace(/\.ts$/, ""));
  }

  return out;
}

function importsAliasHandlers(root: string, route: string): boolean {
  return /^import .*aliasHandlers/m.test(readFileSync(`${root}/${route}.ts`, "utf8"));
}

const bareRoutes = listRouteFiles(API_DIR).filter((route) => !route.startsWith("v1/"));
const v1Routes = listRouteFiles(V1_DIR);

const bareDualMount = bareRoutes.filter((route) => importsAliasHandlers(API_DIR, route));
const v1DualMount = v1Routes.filter((route) => importsAliasHandlers(V1_DIR, route));

describe("/api/v1 ↔ /api dual-mount parity", () => {
  it("actually found the dual-mounted routes (not a vacuous pass)", () => {
    expect(bareDualMount.length).toBeGreaterThanOrEqual(20);
    expect(v1DualMount.length).toBeGreaterThanOrEqual(20);
  });

  it("mirrors every bare dual-mount route under /api/v1", () => {
    const mirrored = new Set(v1DualMount);

    for (const route of bareDualMount) {
      expect(
        mirrored.has(route),
        `/api/${route} imports aliasHandlers but has no /api/v1 mirror — add routes/api/v1/${route}.ts (7 lines, see routes/api/v1/admin/tiktok/auth/start.ts)`,
      ).toBe(true);
    }
  });

  it("backs every /api/v1 dual-mount route with its bare twin", () => {
    const bare = new Set(bareDualMount);

    for (const route of v1DualMount) {
      expect(
        bare.has(route),
        `/api/v1/${route} mirrors a bare route that does not exist — the handler source of truth is routes/api/${route}.ts`,
      ).toBe(true);
    }
  });

  it("accounts for every file under /api/v1 (mirror or documented v1-native)", () => {
    const mirrored = new Set(v1DualMount);

    for (const route of v1Routes) {
      expect(
        mirrored.has(route) || V1_ONLY_ROUTES.has(route),
        `/api/v1/${route} is neither a dual-mount mirror nor a documented v1-native route — mirror it from routes/api/${route}.ts or add it to V1_ONLY_ROUTES with a reason`,
      ).toBe(true);
    }
  });

  it("keeps V1_ONLY_ROUTES honest (no stale entries)", () => {
    const present = new Set(v1Routes);

    for (const route of V1_ONLY_ROUTES) {
      expect(
        present.has(route),
        `V1_ONLY_ROUTES lists "${route}", which is not a v1 route file`,
      ).toBe(true);
    }
  });

  it("keeps the bare-only exception explicit and outside the net", () => {
    for (const route of BARE_ONLY_ROUTES) {
      expect(bareRoutes, `bare-only route "${route}" no longer exists`).toContain(route);

      expect(
        bareDualMount,
        `bare-only route "${route}" imports aliasHandlers — either mirror it under /api/v1 or drop the import`,
      ).not.toContain(route);
    }
  });
});

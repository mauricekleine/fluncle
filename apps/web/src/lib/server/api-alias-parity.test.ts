import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The enforcement net for the `/api/v1` ↔ `/api` DUAL MOUNT (see
// ../../routes/api/-alias.ts). Every file-route carve-out that survived the oRPC
// migration is served canonically under `/api/v1/*` with the bare `/api/*` path kept
// as a back-compat alias — the SAME handler object mounted at both paths. That
// invariant was previously enforced by nothing: five routes (the admin chat spike and
// the Instagram + Twitch OAuth pairs) can drift bare-only because a mirror is a
// separate file somebody has to remember to write. This test remembers.
//
// The discriminator for "this route is dual-mounted" is the `aliasHandlers` import:
// the helper exists solely to unbind the phantom path coupling when one handler object
// is mounted twice, so importing it IS the declaration of intent. A route that mounts
// only once (og.set, below) does not import it and is correctly outside the net.

const API_DIR = fileURLToPath(new URL("../../routes/api", import.meta.url));
const V1_DIR = `${API_DIR}/v1`;

// Files under `/api/v1/**` that legitimately have NO bare twin. These are the v1-native
// surfaces — born at the canonical prefix, never part of the back-compat alias story:
//   - status.ts          the /status liveness resource-read
//   - openapi[.]json.ts  the generated OpenAPI spec
//   - postman[.]json.ts  the generated Postman collection
// Anything else appearing under /api/v1 without a bare twin fails the build, which
// closes the hole neither oRPC coverage net walked (orpc-coverage.test.ts skips the
// `admin` dir, orpc-admin-coverage.test.ts skips the `v1` dir, so `/api/v1/admin/**`
// was checked by neither).
const V1_ONLY_ROUTES = new Set(["openapi[.]json", "postman[.]json", "status"]);

// The bare-only counterpart: a route mounted at `/api/<x>` with no v1 twin, by written
// ruling rather than by omission. The Satori card routes with no /api/v1 twin are the
// instances — the reasoning lives on each route's `serverHandlers` comment (og.set.ts,
// og.hub.ts), and orpc-coverage.test.ts has a dedicated regression test for the bare
// walk. They do not import `aliasHandlers`, so they never enter this net; the constant
// is here to make the exceptions legible rather than invisible.
const BARE_ONLY_ROUTES = new Set(["og.set", "og.hub"]);

// Every `.ts` route file under `dir`, keyed by its path relative to that root, with the
// `-`-prefixed helpers (TanStack's routeFileIgnorePrefix) and colocated `*.test.ts`
// suites excluded — neither is a route.
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

// The bare tree, minus everything under `v1/` (walked separately as its own root).
const bareRoutes = listRouteFiles(API_DIR).filter((route) => !route.startsWith("v1/"));
const v1Routes = listRouteFiles(V1_DIR);

const bareDualMount = bareRoutes.filter((route) => importsAliasHandlers(API_DIR, route));
const v1DualMount = v1Routes.filter((route) => importsAliasHandlers(V1_DIR, route));

describe("/api/v1 ↔ /api dual-mount parity", () => {
  // TRIPWIRE FLOOR. Every assertion below iterates a list built by a regex over file
  // contents; a regex that silently matches nothing turns the whole suite green while
  // checking nothing. This floor makes that failure mode loud. It is a floor, not an
  // exact count — adding a dual-mounted route should not fail a test about vacuity.
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
      // A bare-only route must NOT import aliasHandlers — that import is the dual-mount
      // declaration, and importing it while having no twin is the bug this net catches.
      expect(
        bareDualMount,
        `bare-only route "${route}" imports aliasHandlers — either mirror it under /api/v1 or drop the import`,
      ).not.toContain(route);
    }
  });
});

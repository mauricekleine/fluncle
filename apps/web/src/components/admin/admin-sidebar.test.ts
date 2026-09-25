import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/admin-auth", () => ({ isAdminRequest: async () => false }));
vi.mock("@/lib/server/tracks", () => ({ listTracks: async () => ({ totalCount: 0, tracks: [] }) }));

const { navKeyForPath } = await import("./admin-sidebar");

const ADMIN_ROUTES_DIR = fileURLToPath(new URL("../../routes/admin", import.meta.url));

const NOT_A_STATION = new Set(["login", "route"]);

function adminStationPaths(): string[] {
  return readdirSync(ADMIN_ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => entry.name.replace(/\.tsx$/, ""))
    .filter((basename) => !NOT_A_STATION.has(basename))
    .map((basename) => {
      if (basename === "index") {
        return "/admin";
      }

      const segments = basename
        .split(".")
        .map((segment) => (segment.startsWith("$") ? "rec-0000000000000001" : segment));

      return `/admin/${segments.join("/")}`;
    })
    .sort();
}

describe("navKeyForPath — every admin station resolves to its own nav entry", () => {
  it("finds the route tree (the enumeration is not silently empty)", () => {
    const paths = adminStationPaths();

    expect(paths.length).toBeGreaterThan(15);
    expect(paths).toContain("/admin");
    expect(paths).toContain("/admin/catalogue");
    expect(paths).toContain("/admin/studio/rec-0000000000000001");
  });

  it("never falls through to the default for a station that is not the dashboard", () => {
    for (const path of adminStationPaths()) {
      if (path === "/admin") {
        continue;
      }

      expect(
        navKeyForPath(path),
        `${path} resolves to the "dashboard" FALLBACK — give it a sidebar entry in ALL_ENTRIES (or route it to the entry it belongs under, the way the Studio lights Recordings)`,
      ).not.toBe("dashboard");
    }
  });

  it("lights the dashboard for the /admin landing itself, by exact match", () => {
    expect(navKeyForPath("/admin")).toBe("dashboard");
  });

  it("lights Recordings for the Studio, which has no entry of its own", () => {
    expect(navKeyForPath("/admin/studio")).toBe("recordings");
    expect(navKeyForPath("/admin/studio/rec-0000000000000001")).toBe("recordings");
  });

  it("lights the parent entry for a future nested station (longest prefix wins)", () => {
    expect(navKeyForPath("/admin/findings/004.7.2A")).toBe("findings");
    expect(navKeyForPath("/admin/labels/hospital-records")).toBe("labels");
  });
});

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// `navKeyForPath` is a pure string function, but it lives beside the React component, whose
// module pulls the whole server graph (the nav-counts server fn reads admin-auth + tracks).
// Stub those two leaves so this suite costs a module resolution instead of a cold DB-client
// import — the function under test never touches either.
vi.mock("@/lib/server/admin-auth", () => ({ isAdminRequest: async () => false }));
vi.mock("@/lib/server/tracks", () => ({ listTracks: async () => ({ totalCount: 0, tracks: [] }) }));

const { navKeyForPath } = await import("./admin-sidebar");

// THE NAV HAS TO KNOW WHERE YOU ARE, FOR EVERY STATION THAT EXISTS.
//
// The shell is mounted ONCE in the /admin layout (routes/admin/route.tsx), so no page tells
// it which entry is active — `navKeyForPath` resolves it from the URL alone. Its last line is
// `?? "dashboard"`, which means a station with no matching sidebar entry does not fail loudly:
// it silently lights Dashboard, and the operator navigates a rail that says he is somewhere he
// is not. A new /admin route is exactly the moment that happens, and nothing caught it.
//
// So the route tree is read off disk and every station is required to resolve to a key that is
// NOT the fallback. Adding `src/routes/admin/<thing>.tsx` without adding its sidebar entry now
// fails here, with the path named.

const ADMIN_ROUTES_DIR = fileURLToPath(new URL("../../routes/admin", import.meta.url));

// Route files that are not stations: the pathless layout, and login — pre-auth, outside the
// fiction, and the one page route.tsx renders WITHOUT the shell, so navKeyForPath is never
// asked about it (see routes/admin/route.tsx).
const NOT_A_STATION = new Set(["login", "route"]);

/** A concrete pathname for each `/admin/*` station route file on disk. */
function adminStationPaths(): string[] {
  return readdirSync(ADMIN_ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => entry.name.replace(/\.tsx$/, ""))
    .filter((basename) => !NOT_A_STATION.has(basename))
    .map((basename) => {
      if (basename === "index") {
        return "/admin";
      }

      // `studio.$recordingId` → a real nested path with the param filled in, so the
      // prefix/param resolution is exercised the way a click does it.
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
        continue; // The attention queue OWNS "dashboard" — that is a real match, not the fallback.
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
    // "/admin" is excluded from the prefix pass on purpose: otherwise it would swallow
    // every deeper path before a real entry could claim it.
    expect(navKeyForPath("/admin/findings/004.7.2A")).toBe("findings");
    expect(navKeyForPath("/admin/labels/hospital-records")).toBe("labels");
  });
});

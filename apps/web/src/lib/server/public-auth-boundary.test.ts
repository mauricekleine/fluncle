import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("public auth boundary", () => {
  it("does not import or reuse admin auth helpers", async () => {
    const publicAuth = await source("./public-auth.ts");

    expect(publicAuth).not.toContain("requireAdmin");
    expect(publicAuth).not.toContain("fluncle_admin");
    expect(publicAuth).not.toContain("signState");
    expect(publicAuth).not.toContain("verifyState");
    expect(publicAuth).not.toContain("admin-auth");
  });

  it("keeps Better Auth routes away from spotify_auth", async () => {
    const [publicAuth, authRoute] = await Promise.all([
      source("./public-auth.ts"),
      source("../../routes/api/auth/$.ts"),
    ]);

    expect(publicAuth).not.toContain("spotify_auth");
    expect(authRoute).not.toContain("spotify_auth");
  });

  it("keeps the admin Spotify callback from creating public users", async () => {
    const callback = await source("../../routes/api/admin/spotify/auth/callback.ts");

    expect(callback).not.toContain("getPublicAuth");
    expect(callback).not.toContain("betterAuth");
    expect(callback).not.toContain('from "../../../../../db/schema"');
    expect(callback).toContain("exchangeCodeForToken");
  });
});

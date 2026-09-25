import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

await mock.module("node:os", () => ({
  homedir: () => home,
  tmpdir,
}));

const { clearUserToken, readUserToken, userTokenLocation, writeUserToken } =
  await import("./user-token");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fluncle-user-token-"));
  delete process.env.FLUNCLE_ENV;
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
  delete process.env.FLUNCLE_ENV;
  delete process.env.FLUNCLE_API_TOKEN;
});

describe("user-token store", () => {
  test("round-trips a stored user token", () => {
    expect(readUserToken()).toBeUndefined();

    writeUserToken({
      baseUrl: "https://www.fluncle.com",
      token: "user-session-token-abc",
      user: { id: "user_1", username: "raver" },
    });

    const read = readUserToken();
    expect(read?.token).toBe("user-session-token-abc");
    expect(read?.user?.username).toBe("raver");
  });

  test("stores the token in a DISTINCT file, never the admin env file", () => {
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok" });

    const location = userTokenLocation();

    expect(location).toContain("user.production.json");
    expect(location).not.toContain(".env.");

    const adminEnvPath = join(home, ".config", "fluncle", ".env.production");
    expect(() => readFileSync(adminEnvPath, "utf8")).toThrow();
  });

  test("keys the token file by env profile so local and production never collide", () => {
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "prod-token" });
    expect(userTokenLocation()).toContain("user.production.json");

    process.env.FLUNCLE_ENV = "local";

    expect(readUserToken()).toBeUndefined();
    writeUserToken({ baseUrl: "http://localhost:3000", token: "local-token" });
    expect(userTokenLocation()).toContain("user.local.json");
    expect(readUserToken()?.token).toBe("local-token");

    delete process.env.FLUNCLE_ENV;
    expect(readUserToken()?.token).toBe("prod-token");
  });

  test("never reads or writes FLUNCLE_API_TOKEN (the admin grant)", () => {
    process.env.FLUNCLE_API_TOKEN = "admin-secret-token";

    expect(readUserToken()).toBeUndefined();

    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok" });

    expect(process.env.FLUNCLE_API_TOKEN).toBe("admin-secret-token");

    const persisted = readFileSync(userTokenLocation(), "utf8");
    expect(persisted).toContain("user-tok");
    expect(persisted).not.toContain("admin-secret-token");
  });

  test("writes the token file with 0600 permissions", () => {
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok" });

    const mode = statSync(userTokenLocation()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("tightens an ALREADY-LOOSE token file back to 0600 on re-login", () => {
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "first" });
    chmodSync(userTokenLocation(), 0o644);
    expect(statSync(userTokenLocation()).mode & 0o777).toBe(0o644);

    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "second" });

    expect(statSync(userTokenLocation()).mode & 0o777).toBe(0o600);

    expect(readUserToken()?.token).toBe("second");
  });

  test("creates the config dir 0700, and tightens a loose existing one", () => {
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok" });

    const dir = join(home, ".config", "fluncle");
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    chmodSync(dir, 0o755);
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok-2" });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readUserToken()?.token).toBe("user-tok-2");
  });

  test("clears the token (logout) and reports whether anything was removed", () => {
    expect(clearUserToken()).toBe(false);

    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok" });
    expect(clearUserToken()).toBe(true);
    expect(readUserToken()).toBeUndefined();
  });

  test("treats a corrupt token file as signed-out instead of throwing", () => {
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok" });
    writeFileSync(userTokenLocation(), "not json at all", "utf8");

    expect(readUserToken()).toBeUndefined();
  });
});

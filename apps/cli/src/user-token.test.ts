import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store resolves the config dir from `homedir()` + `FLUNCLE_ENV` at call time.
// `homedir()` is cached by the runtime, so we mock `node:os` to return a throwaway
// dir per test (the bun-test idiom). The whole point of these tests is the HARD
// boundary between the user token (this store) and the admin `FLUNCLE_API_TOKEN`
// (an env var the admin path reads) — they must never share a file, a reader, or
// a name.

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

    // The user token lives at `user.<profile>.json` — NOT the `.env.<profile>` file
    // the admin env-loader (env.ts) reads for FLUNCLE_API_TOKEN.
    expect(location).toContain("user.production.json");
    expect(location).not.toContain(".env.");

    // And the admin env file must not exist as a side effect of writing the user token.
    const adminEnvPath = join(home, ".config", "fluncle", ".env.production");
    expect(() => readFileSync(adminEnvPath, "utf8")).toThrow();
  });

  test("keys the token file by env profile so local and production never collide", () => {
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "prod-token" });
    expect(userTokenLocation()).toContain("user.production.json");

    process.env.FLUNCLE_ENV = "local";

    // The local profile sees no token (its file is separate)…
    expect(readUserToken()).toBeUndefined();
    writeUserToken({ baseUrl: "http://localhost:3000", token: "local-token" });
    expect(userTokenLocation()).toContain("user.local.json");
    expect(readUserToken()?.token).toBe("local-token");

    // …and the production token is still intact and distinct.
    delete process.env.FLUNCLE_ENV;
    expect(readUserToken()?.token).toBe("prod-token");
  });

  test("never reads or writes FLUNCLE_API_TOKEN (the admin grant)", () => {
    process.env.FLUNCLE_API_TOKEN = "admin-secret-token";

    // Reading the user token must not surface the admin token…
    expect(readUserToken()).toBeUndefined();

    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok" });

    // …and writing the user token must not touch the admin env var.
    expect(process.env.FLUNCLE_API_TOKEN).toBe("admin-secret-token");

    // The persisted file must contain only the user token, never the admin one.
    const persisted = readFileSync(userTokenLocation(), "utf8");
    expect(persisted).toContain("user-tok");
    expect(persisted).not.toContain("admin-secret-token");
  });

  test("writes the token file with 0600 permissions", () => {
    writeUserToken({ baseUrl: "https://www.fluncle.com", token: "user-tok" });

    const mode = statSync(userTokenLocation()).mode & 0o777;
    expect(mode).toBe(0o600);
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

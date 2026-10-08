import { describe, expect, it } from "vitest";

import { type CommandRunner, opReference, resolveProductionCredentials } from "./prod-credentials";

const TOKEN = "secret-token-value";
const URL = "libsql://example-db.example.test";

function recorder(answer: (command: string[]) => string | Error): {
  calls: string[][];
  run: CommandRunner;
} {
  const calls: string[][] = [];

  return {
    calls,
    run: async (command) => {
      calls.push(command);
      const result = answer(command);

      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
  };
}

function answerByField(command: string[]): string {
  const target = command.join(" ");

  if (target.includes("TURSO_DATABASE_URL") || target.includes("--url")) {
    return `${URL}\n`;
  }

  return `${TOKEN}\n`;
}

describe("opReference", () => {
  it("adds the op:// scheme that op read requires", () => {
    expect(opReference("<vault with spaces>/<item>", "TURSO_AUTH_TOKEN")).toBe(
      "op://<vault with spaces>/<item>/TURSO_AUTH_TOKEN",
    );
  });

  it("keeps a reference that already carries the scheme or a trailing slash", () => {
    expect(opReference("op://<vault>/<item>/", "TURSO_DATABASE_URL")).toBe(
      "op://<vault>/<item>/TURSO_DATABASE_URL",
    );
  });
});

describe("resolveProductionCredentials", () => {
  it("uses the environment pair without running any tool", async () => {
    const { calls, run } = recorder(() => new Error("must not run"));

    const credentials = await resolveProductionCredentials(
      {
        FLUNCLE_TURSO_OP_ITEM: "<vault>/<item>",
        TURSO_AUTH_TOKEN: ` ${TOKEN} `,
        TURSO_DATABASE_URL: `${URL}\n`,
      },
      run,
    );

    expect(credentials).toMatchObject({ authToken: TOKEN, source: "environment", url: URL });
    expect(calls).toEqual([]);
  });

  it("rejects a half-set environment pair instead of silently falling through", async () => {
    const { calls, run } = recorder(() => new Error("must not run"));

    await expect(resolveProductionCredentials({ TURSO_DATABASE_URL: URL }, run)).rejects.toThrow(
      /TURSO_AUTH_TOKEN is not/,
    );
    expect(calls).toEqual([]);
  });

  it("reads the 1Password item through op:// references with the Fluncle account", async () => {
    const { calls, run } = recorder(answerByField);

    const credentials = await resolveProductionCredentials(
      {
        FLUNCLE_1PASSWORD_ACCOUNT: "https://example.1password.com/",
        FLUNCLE_TURSO_OP_ITEM: "<vault>/<item>",
      },
      run,
    );

    expect(credentials).toMatchObject({ authToken: TOKEN, source: "1password", url: URL });
    expect(calls).toEqual([
      [
        "op",
        "read",
        "op://<vault>/<item>/TURSO_DATABASE_URL",
        "--account",
        "https://example.1password.com/",
      ],
      [
        "op",
        "read",
        "op://<vault>/<item>/TURSO_AUTH_TOKEN",
        "--account",
        "https://example.1password.com/",
      ],
    ]);
  });

  it("omits --account when FLUNCLE_1PASSWORD_ACCOUNT is unset", async () => {
    const { calls, run } = recorder(answerByField);

    await resolveProductionCredentials({ FLUNCLE_TURSO_OP_ITEM: "op://<vault>/<item>" }, run);

    expect(calls).toEqual([
      ["op", "read", "op://<vault>/<item>/TURSO_DATABASE_URL"],
      ["op", "read", "op://<vault>/<item>/TURSO_AUTH_TOKEN"],
    ]);
  });

  it("names the 1Password path and the tool's error when op read fails, never a value", async () => {
    const { run } = recorder((command) =>
      command.includes("op://<vault>/<item>/TURSO_AUTH_TOKEN")
        ? new Error("[ERROR] authorization timeout")
        : `${URL}\n`,
    );

    const failure = resolveProductionCredentials({ FLUNCLE_TURSO_OP_ITEM: "<vault>/<item>" }, run);

    await expect(failure).rejects.toThrow(/1Password \(FLUNCLE_TURSO_OP_ITEM\)/);
    await expect(failure).rejects.toThrow(/authorization timeout/);
    await expect(failure).rejects.not.toThrow(new RegExp(URL));
  });

  it("falls back to a read-only one-hour turso CLI token for the default database", async () => {
    const { calls, run } = recorder(answerByField);

    const credentials = await resolveProductionCredentials({}, run);

    expect(credentials).toMatchObject({ authToken: TOKEN, source: "turso-cli", url: URL });
    expect(calls).toEqual([
      ["turso", "db", "show", "fluncle", "--url"],
      ["turso", "db", "tokens", "create", "fluncle", "--read-only", "--expiration", "1h"],
    ]);
  });

  it("lets FLUNCLE_TURSO_DB choose the database for the turso CLI", async () => {
    const { calls, run } = recorder(answerByField);

    await resolveProductionCredentials({ FLUNCLE_TURSO_DB: "fluncle-staging" }, run);

    expect(calls).toHaveLength(2);
    expect(calls.every((command) => command.includes("fluncle-staging"))).toBe(true);
  });

  it("names the turso CLI path when it fails or prints nothing", async () => {
    const { run: failing } = recorder(() => new Error("not logged in"));
    const { run: silent } = recorder(() => "\n");

    await expect(resolveProductionCredentials({}, failing)).rejects.toThrow(
      /the turso CLI \(database fluncle\): `turso db show` failed: not logged in/,
    );
    await expect(resolveProductionCredentials({}, silent)).rejects.toThrow(/printed nothing/);
  });
});

import { describe, expect, test } from "bun:test";

import { buildChildEnv, childEnv, INHERITED_ENV_KEYS } from "./child-env";

describe("the least-privilege child env", () => {
  test("the base carries only the inherited keys, admin off by default", () => {
    const env = buildChildEnv(
      { HOME: "/Users/op", PATH: "/usr/bin" },
      { adminEnv: () => ({ FLUNCLE_API_TOKEN: "secret" }) },
    );

    expect(env).toEqual({ HOME: "/Users/op", PATH: "/usr/bin" });
  });

  test("adminToken: true presents the credentials, deliberately", () => {
    const env = buildChildEnv(
      { PATH: "/usr/bin" },
      { adminEnv: () => ({ FLUNCLE_API_TOKEN: "secret" }), adminToken: true },
    );

    expect(env.FLUNCLE_API_TOKEN).toBe("secret");
  });

  test("the caller's explicit extras always win", () => {
    const env = buildChildEnv({ PATH: "/usr/bin" }, { extra: { LANG: "C", PATH: "/opt/bin" } });

    expect(env).toEqual({ LANG: "C", PATH: "/opt/bin" });
  });

  test("the daemon's own process.env never rides along — token included", () => {
    process.env.FLUNCLE_HELM_TEST_CANARY = "leaked";
    process.env.FLUNCLE_API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "leaked-token";

    try {
      const env = childEnv({});

      expect(env.FLUNCLE_HELM_TEST_CANARY).toBeUndefined();
      expect(env.FLUNCLE_API_TOKEN).toBeUndefined();

      for (const key of Object.keys(env)) {
        expect(INHERITED_ENV_KEYS as readonly string[]).toContain(key);
      }
    } finally {
      delete process.env.FLUNCLE_HELM_TEST_CANARY;

      if (process.env.FLUNCLE_API_TOKEN === "leaked-token") {
        delete process.env.FLUNCLE_API_TOKEN;
      }
    }
  });
});

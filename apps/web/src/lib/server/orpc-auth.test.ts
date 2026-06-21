import { beforeAll, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { adminProcedure, operatorProcedure } from "./orpc-auth";

// The admin auth spine (docs/orpc-migration-brief.md). The contract op these
// procedures are bound to is `get_track`, so each test attaches a trivial
// `.handler` and invokes it with `call(...)`, exercising the middleware tier in
// isolation from any route. The role model itself (token → operator/agent → null)
// is `adminRole` in env.ts, covered there; here we assert the procedures map a
// resolved role onto the right HTTP tier.

const OPERATOR_TOKEN = "test-operator-token-orpc-auth";
const AGENT_TOKEN = "test-agent-token-orpc-auth";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
});

function requestAs(token?: string): Request {
  return new Request("https://www.fluncle.com/api/v1/tracks/abc", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    method: "GET",
  });
}

// A handler that echoes the resolved role, on each procedure tier.
const adminEcho = adminProcedure.handler(({ context }) => ({
  ok: true as const,
  role: context.role,
}));
const operatorEcho = operatorProcedure.handler(({ context }) => ({
  ok: true as const,
  role: context.role,
}));

async function invoke(
  procedure: typeof adminEcho | typeof operatorEcho,
  token?: string,
): Promise<{ status?: number; role?: string }> {
  try {
    const result = await call(
      procedure,
      { idOrLogId: "abc" },
      { context: { request: requestAs(token) } },
    );

    return { role: (result as { role: string }).role };
  } catch (error) {
    return { status: (error as { status?: number }).status };
  }
}

describe("adminProcedure (= requireAdmin)", () => {
  it("401s a request with no admin principal", async () => {
    expect(await invoke(adminEcho)).toEqual({ status: 401 });
  });

  it("passes the operator, lifting role into context", async () => {
    expect(await invoke(adminEcho, OPERATOR_TOKEN)).toEqual({ role: "operator" });
  });

  it("passes the agent (any admin principal)", async () => {
    expect(await invoke(adminEcho, AGENT_TOKEN)).toEqual({ role: "agent" });
  });
});

describe("operatorProcedure (= requireOperator)", () => {
  it("401s a non-admin", async () => {
    expect(await invoke(operatorEcho)).toEqual({ status: 401 });
  });

  it("403s the agent role (authenticated, lacks the role)", async () => {
    expect(await invoke(operatorEcho, AGENT_TOKEN)).toEqual({ status: 403 });
  });

  it("passes the operator", async () => {
    expect(await invoke(operatorEcho, OPERATOR_TOKEN)).toEqual({ role: "operator" });
  });
});

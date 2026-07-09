import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ServiceStatusRow } from "./status";

// `get_status` is the only tool exercised here, so we mock just the status store it
// reads. The other tools' dependencies (spotify, newsletter, submissions, tracks) are
// imported by mcp.ts but never invoked by these JSON-RPC calls, so they stay real.
const statuses = vi.hoisted(() => vi.fn<() => Promise<ServiceStatusRow[]>>());

vi.mock("./status", () => ({
  getServiceStatuses: statuses,
}));

const { handleMcp } = await import("./mcp");

function row(overrides: Partial<ServiceStatusRow> & Pick<ServiceStatusRow, "service" | "status">) {
  return {
    checked_at: "2026-06-25T00:00:00.000Z",
    latency_ms: 42,
    message: null,
    since: "2026-06-25T00:00:00.000Z",
    ...overrides,
  } satisfies ServiceStatusRow;
}

async function callTool(
  name: string,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const response = await handleMcp(
    new Request("https://www.fluncle.com/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  );

  if (!response) {
    throw new Error("handleMcp returned no response");
  }

  const body = (await response.json()) as {
    result: { content: Array<{ text: string }>; isError: boolean };
  };
  const text = body.result.content[0]?.text ?? "{}";

  return { data: JSON.parse(text) as Record<string, unknown>, isError: body.result.isError };
}

describe("MCP get_status tool", () => {
  beforeEach(() => {
    statuses.mockReset();
  });

  it("is advertised in tools/list with a verb_noun name", async () => {
    const response = await handleMcp(
      new Request("https://www.fluncle.com/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    if (!response) {
      throw new Error("handleMcp returned no response");
    }

    const body = (await response.json()) as {
      result: { tools: Array<{ description: string; name: string; title: string }> };
    };
    const tool = body.result.tools.find((candidate) => candidate.name === "get_status");

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Are all systems up?");
  });

  it("reports ok with an all-up headline when every service is ok", async () => {
    statuses.mockResolvedValue([
      row({ service: "web", status: "ok" }),
      row({ service: "ssh", status: "ok" }),
    ]);

    const { data, isError } = await callTool("get_status");

    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.headline).toBe("All 2 Fluncle systems are operational.");
    expect(data.services).toHaveLength(2);
  });

  it("flips ok false and names the failing service when one is down", async () => {
    statuses.mockResolvedValue([
      row({ message: "502 from origin", service: "web", status: "down" }),
      row({ service: "ssh", status: "ok" }),
    ]);

    const { data } = await callTool("get_status");

    expect(data.ok).toBe(false);
    expect(data.headline).toContain("web down");
    const services = data.services as Array<{ message: string | null; name: string }>;
    expect(services[0]).toMatchObject({ message: "502 from origin", name: "web" });
  });

  it("treats degraded as not-ok and names it", async () => {
    statuses.mockResolvedValue([row({ service: "r2", status: "degraded" })]);

    const { data } = await callTool("get_status");

    expect(data.ok).toBe(false);
    expect(data.headline).toContain("r2 degraded");
  });

  it("labels each service from the surfaces registry", async () => {
    statuses.mockResolvedValue([row({ service: "r2", status: "ok" })]);

    const { data } = await callTool("get_status");
    const services = data.services as Array<{ label: string; name: string }>;

    expect(services[0]?.name).toBe("r2");
    // The registry's media-zone surface (operatorNotes: "…as service `r2`") supplies
    // the label, so it is never the bare id when the registry knows the service.
    expect(services[0]?.label).not.toBe("r2");
    expect(typeof services[0]?.label).toBe("string");
  });

  it("reports unknown (ok false) when the store is empty", async () => {
    statuses.mockResolvedValue([]);

    const { data } = await callTool("get_status");

    expect(data.ok).toBe(false);
    expect(data.headline).toBe("No service has reported its health yet.");
    expect(data.services).toHaveLength(0);
  });
});

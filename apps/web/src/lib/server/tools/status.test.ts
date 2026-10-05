import { liveSurfaces } from "@fluncle/registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getServiceStatusesMock = vi.hoisted(() => vi.fn());

vi.mock("../status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../status")>()),
  getServiceStatuses: getServiceStatusesMock,
}));

const { SHARED_TOOLS } = await import("./registry");

type McpStatus = { services: Array<{ label: string; name: string }> };

function row(service: string) {
  return {
    checked_at: "2026-10-06T00:00:00.000Z",
    latency_ms: null,
    message: null,
    service,
    since: null,
    status: "ok",
  };
}

async function mcpStatus(): Promise<McpStatus> {
  const tool = SHARED_TOOLS.find((candidate) => candidate.name === "get_status");

  if (!tool) {
    throw new Error("get_status missing");
  }

  return (await tool.execute({}, { transport: "mcp" })) as McpStatus;
}

beforeEach(() => {
  getServiceStatusesMock.mockReset();
});

describe("get_status over MCP — service labels", () => {
  it("labels every titled cron with its registry title, never its raw id", async () => {
    const crons = liveSurfaces().filter((surface) => surface.kind === "cron" && surface.title);
    getServiceStatusesMock.mockResolvedValue(crons.map((surface) => row(surface.name)));

    const { services } = await mcpStatus();

    expect(crons.length).toBeGreaterThan(0);
    for (const service of services) {
      expect(service.label).not.toBe(service.name);
    }
    expect(services.find((service) => service.name === "cron.enrich")?.label).toBe(
      "Audio enrichment",
    );
  });

  it("falls back to the raw id for a service the registry does not know", async () => {
    getServiceStatusesMock.mockResolvedValue([row("not-a-service")]);

    const { services } = await mcpStatus();

    expect(services).toEqual([expect.objectContaining({ label: "not-a-service" })]);
  });
});

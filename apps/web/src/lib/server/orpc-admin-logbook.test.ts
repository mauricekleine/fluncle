import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// The `admin-logbook` auth proof, driven end-to-end through `handleOrpc` so the REAL
// admin auth spine (../orpc-auth) runs; only the `logbook` data layer is mocked. The
// security-critical claim: `update_logbook_entry` is OPERATOR tier (it can clobber a
// cron-authored entry), so a valid AGENT token is a 403. The agent-tier ops
// (`list_logbook_gaps`, `create_logbook_entry`) let the agent through. Every op 401s
// without a token.

const createLogbookEntry = vi.fn();
const listLogbookGaps = vi.fn();
const listSpentMoves = vi.fn();
const updateLogbookEntry = vi.fn();

vi.mock("./logbook", async () => {
  const actual = await vi.importActual<typeof import("./logbook")>("./logbook");

  return {
    createLogbookEntry: (...args: unknown[]) => createLogbookEntry(...args),
    listLogbookGaps: (...args: unknown[]) => listLogbookGaps(...args),
    listSpentMoves: (...args: unknown[]) => listSpentMoves(...args),
    // Keep the real `requireSector` (the handlers call it to parse the path param).
    requireSector: actual.requireSector,
    updateLogbookEntry: (...args: unknown[]) => updateLogbookEntry(...args),
  };
});

const ENTRY = {
  body: "The day rolled in on a low sub.\n\n[[036.7.2I]]",
  generatedAt: "2026-07-05T00:00:00.000Z",
  generatedBy: "agent" as const,
  sector: 36,
  title: "Sector 036 — a slow drift",
};

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  createLogbookEntry.mockReset();
  listLogbookGaps.mockReset();
  listSpentMoves.mockReset();
  updateLogbookEntry.mockReset();
});

// ── list_logbook_gaps — admin tier ───────────────────────────────────────────
describe("oRPC list_logbook_gaps (GET /admin/logbook/gaps)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    expect((await handleOrpc(req("/admin/logbook/gaps", "GET", undefined)))?.status).toBe(401);
    expect(listLogbookGaps).not.toHaveBeenCalled();
  });

  it("lets the AGENT read the gap worklist (with the spent anti-sameness fuel)", async () => {
    listLogbookGaps.mockResolvedValueOnce([]);
    listSpentMoves.mockResolvedValueOnce([
      { closer: "I played it twice.", opener: "A low sub opened.", sector: 35, title: "A drift" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/logbook/gaps", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      gaps: [],
      ok: true,
      spent: [
        { closer: "I played it twice.", opener: "A low sub opened.", sector: 35, title: "A drift" },
      ],
    });
  });
});

// ── create_logbook_entry — admin tier (fill-empty-only) ──────────────────────
describe("oRPC create_logbook_entry (POST /admin/logbook/{sector})", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/logbook/036", "POST", undefined, { body: ENTRY.body, title: ENTRY.title }),
    );

    expect(response?.status).toBe(401);
    expect(createLogbookEntry).not.toHaveBeenCalled();
  });

  it("lets the AGENT author, parsing the padded sector param", async () => {
    createLogbookEntry.mockResolvedValueOnce({ entry: ENTRY, skipped: false });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/logbook/036", "POST", AGENT_TOKEN, { body: ENTRY.body, title: ENTRY.title }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ entry: ENTRY, ok: true });
    // The padded "036" param is parsed to the number 36.
    // `promptVersion: null` — this call sent no `--prompt-version`, so the entry's
    // provenance is NULL: no registry prompt authored it (docs/agents/prompt-registry.md).
    expect(createLogbookEntry).toHaveBeenCalledWith(36, {
      body: ENTRY.body,
      promptVersion: null,
      title: ENTRY.title,
    });
  });

  it("reports `skipped: true` when the sector already has an entry (no clobber)", async () => {
    createLogbookEntry.mockResolvedValueOnce({ entry: ENTRY, skipped: true });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/logbook/036", "POST", AGENT_TOKEN, { body: ENTRY.body, title: ENTRY.title }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ entry: ENTRY, ok: true, skipped: true });
  });
});

// ── update_logbook_entry — OPERATOR tier ─────────────────────────────────────
describe("oRPC update_logbook_entry (PATCH /admin/logbook/{sector})", () => {
  it("403s the AGENT (operator-only — the agent cannot overwrite an entry)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/logbook/036", "PATCH", AGENT_TOKEN, { body: ENTRY.body, title: ENTRY.title }),
    );

    expect(response?.status).toBe(403);
    expect(updateLogbookEntry).not.toHaveBeenCalled();
  });

  it("overwrites for the operator and returns `{ entry, ok }`", async () => {
    updateLogbookEntry.mockResolvedValueOnce({ ...ENTRY, generatedBy: "operator" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/logbook/036", "PATCH", OPERATOR_TOKEN, { body: ENTRY.body, title: ENTRY.title }),
    );

    expect(response?.status).toBe(200);
    expect(
      ((await readJson(response)) as { entry: { generatedBy: string } }).entry.generatedBy,
    ).toBe("operator");
    expect(updateLogbookEntry).toHaveBeenCalledWith(36, { body: ENTRY.body, title: ENTRY.title });
  });
});

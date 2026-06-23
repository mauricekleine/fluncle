import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEdition,
  deleteEdition,
  getEditionByNumber,
  listEditions,
  sendEdition,
  updateEdition,
} from "./editions";

// The editions choreography backed by a single mutable row, answered by SQL shape —
// enough to prove the mint-on-send number assignment, the sent-only reads, and the
// draft/sent guards without a real libsql instance. The Resend send is mocked so no
// real broadcast goes out.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ maxNumber: 0, row: {} as Row }));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    // The insert (create) / update (patch) writes — return nothing; the readback
    // SELECT returns the current row state below.
    if (query.sql.startsWith("insert into editions") || query.sql.startsWith("update editions")) {
      return { rows: [] };
    }

    // The hard delete — `returning id`. A present row yields its id (no status
    // filter: delete reaches sent editions too); an absent one yields nothing so
    // the server throws not-found.
    if (query.sql.startsWith("delete from editions")) {
      return { rows: state.row.id ? [{ id: state.row.id }] : [] };
    }

    // A read (EDITION_SELECT). For the sent-only filter, return nothing if the row
    // is a draft; otherwise return the row.
    const wantsSentOnly = query.sql.includes("status = 'sent'");

    if (wantsSentOnly && state.row.status !== "sent") {
      return { rows: [] };
    }

    return { rows: [state.row] };
  }),
);

const batch = vi.hoisted(() =>
  vi.fn(async () => {
    // The mint-on-send batch: assign max(number)+1, flip to sent, stamp provenance.
    state.row.number = state.maxNumber + 1;
    state.row.status = "sent";
    state.row.send_provider = "resend";
    state.row.send_external_id = "bc_test_123";
    state.row.sent_at = "2026-06-26T00:00:00.000Z";
    return [{ rows: [{ number: state.row.number }] }];
  }),
);

vi.mock("./db", () => ({
  getDb: async () => ({ batch, execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const createBroadcast = vi.hoisted(() => vi.fn(async () => ({ id: "bc_test_123" })));
const sendBroadcast = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./resend", () => ({
  createBroadcast,
  sendBroadcast,
}));

vi.mock("./edition-email", () => ({
  renderEditionEmailHtml: () => "<html><body>edition</body></html>",
}));

function seedDraft(overrides: Partial<Row> = {}): void {
  state.maxNumber = 0;
  state.row = {
    added_at: null,
    content_json: JSON.stringify({ intro: "Ahoy." }),
    created_at: "2026-06-26T00:00:00.000Z",
    id: "edition-id",
    number: null,
    send_external_id: null,
    send_provider: null,
    sent_at: null,
    status: "draft",
    subject: "Edition No. 1",
    updated_at: "2026-06-26T00:00:00.000Z",
    window_since: null,
    window_until: null,
    ...overrides,
  };
}

describe("createEdition / updateEdition", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  it("creates a draft with no number", async () => {
    seedDraft({ number: null, status: "draft" });

    const edition = await createEdition({
      contentJson: { intro: "Ahoy cosmonauts." },
      subject: "First dispatch",
    });

    expect(edition.status).toBe("draft");
    expect(edition.number).toBeUndefined();
  });

  it("rejects a create with no content payload", async () => {
    seedDraft();
    await expect(createEdition({ subject: "Empty" })).rejects.toThrow(/content/i);
  });

  it("rejects editing a sent edition (frozen back-issue)", async () => {
    seedDraft({ number: 1, status: "sent" });
    await expect(updateEdition("edition-id", { subject: "Tweak" })).rejects.toThrow(/frozen/i);
  });
});

describe("sendEdition — mint-on-send + Resend broadcast", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
    createBroadcast.mockClear();
    sendBroadcast.mockClear();
  });

  it("creates + sends the Resend broadcast and mints the sequential number", async () => {
    seedDraft();

    const sent = await sendEdition("edition-id");

    expect(createBroadcast).toHaveBeenCalledTimes(1);
    expect(sendBroadcast).toHaveBeenCalledWith("bc_test_123", {});
    expect(sent.status).toBe("sent");
    expect(sent.number).toBe(1);
  });

  it("mints number = max(number)+1 (continues the sequence)", async () => {
    seedDraft();
    state.maxNumber = 7;

    const sent = await sendEdition("edition-id");

    expect(sent.number).toBe(8);
  });

  it("passes a scheduledAt through to the broadcast send", async () => {
    seedDraft();

    await sendEdition("edition-id", { scheduledAt: "in 1 hour" });

    expect(sendBroadcast).toHaveBeenCalledWith("bc_test_123", { scheduledAt: "in 1 hour" });
  });

  it("refuses to re-send an already-sent edition (no double-mail)", async () => {
    seedDraft({ number: 1, status: "sent" });

    await expect(sendEdition("edition-id")).rejects.toThrow(/already/i);
    expect(createBroadcast).not.toHaveBeenCalled();
  });

  it("refuses to send a draft with no subject", async () => {
    seedDraft({ subject: null });

    await expect(sendEdition("edition-id")).rejects.toThrow(/subject/i);
    expect(createBroadcast).not.toHaveBeenCalled();
  });
});

describe("deleteEdition — hard delete at any status", () => {
  beforeEach(() => {
    execute.mockClear();
  });

  it("deletes a draft and returns its id", async () => {
    seedDraft({ number: null, status: "draft" });

    await expect(deleteEdition("edition-id")).resolves.toEqual({ id: "edition-id" });
  });

  it("deletes a SENT edition too (no frozen guard — pulls it from the archive)", async () => {
    seedDraft({ number: 1, status: "sent" });

    await expect(deleteEdition("edition-id")).resolves.toEqual({ id: "edition-id" });
  });

  it("throws not-found when the row is absent", async () => {
    seedDraft({ id: "" });

    await expect(deleteEdition("missing-id")).rejects.toThrow(/not found/i);
  });
});

describe("reads — sent-only", () => {
  beforeEach(() => {
    execute.mockClear();
  });

  it("getEditionByNumber returns nothing for a draft", async () => {
    seedDraft({ number: null, status: "draft" });
    await expect(getEditionByNumber(1)).resolves.toBeUndefined();
  });

  it("getEditionByNumber returns a sent edition", async () => {
    seedDraft({ number: 1, status: "sent" });
    const edition = await getEditionByNumber(1);
    expect(edition?.number).toBe(1);
    expect(edition?.content.intro).toBe("Ahoy.");
  });

  it("listEditions returns sent editions", async () => {
    seedDraft({ number: 1, status: "sent" });
    const editions = await listEditions();
    expect(editions).toHaveLength(1);
    expect(editions[0]?.status).toBe("sent");
  });
});

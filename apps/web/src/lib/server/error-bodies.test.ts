import { ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorResponse } from "./http-errors";
import { apiFault, type ApiFaultData, isApiFaultData } from "./orpc/_shared";
import { ApiError } from "./spotify";

// Regression pins for the unexpected-500 branch: a deliberate `ApiError` keeps
// its precise status/code/message (a client contract the CLI renders), while an
// *unexpected* fault answers generically and its raw detail goes to the server
// log — never onto the wire to an unauthenticated caller.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiFault — the oRPC catch converter", () => {
  it("genericizes an unexpected fault and never leaks the raw message", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fault = apiFault(new Error("secret-internal-detail"));

    expect(fault).toBeInstanceOf(ORPCError);
    expect(fault.status).toBe(500);
    expect(fault.message).toBe("Internal error");
    const data = fault.data as ApiFaultData;
    expect(isApiFaultData(data)).toBe(true);
    expect(data).toEqual({ apiCode: "error", apiMessage: "Internal error" });
    expect(JSON.stringify(fault)).not.toContain("secret-internal-detail");
    // The raw detail was logged server-side (the error object, stack included).
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("passes a deliberate ApiError through unchanged (the client contract)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fault = apiFault(new ApiError("rate_limited", "Slow down there, traveler", 429));

    expect(fault.status).toBe(429);
    expect(fault.message).toBe("Slow down there, traveler");
    expect(fault.data).toEqual({
      apiCode: "rate_limited",
      apiMessage: "Slow down there, traveler",
    });
    // The deliberate branch does not log — nothing unexpected happened.
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("apiErrorResponse — the legacy file-route converter", () => {
  async function readBody(response: Response) {
    return (await response.json()) as { code: string; message: string; ok: boolean };
  }

  it("genericizes an unexpected fault and never leaks the raw message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = apiErrorResponse(new Error("secret-internal-detail"));

    expect(response.status).toBe(500);
    const body = await readBody(response);
    expect(body).toEqual({ code: "error", message: "Internal error", ok: false });
    expect(JSON.stringify(body)).not.toContain("secret-internal-detail");
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("passes a deliberate ApiError through unchanged (the client contract)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = apiErrorResponse(new ApiError("note_too_long", "Note must be shorter", 422));

    expect(response.status).toBe(422);
    expect(await readBody(response)).toEqual({
      code: "note_too_long",
      message: "Note must be shorter",
      ok: false,
    });
    expect(errSpy).not.toHaveBeenCalled();
  });
});

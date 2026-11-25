import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, readJson, warmOrpcRouter } from "./orpc-test-kit";

const requirePublicUser = vi.fn();
const getFrontierEdition = vi.fn();
const getFrontierEditions = vi.fn();

vi.mock("./public-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-auth")>();

  return {
    ...actual,
    requirePublicUser: (...args: unknown[]) => requirePublicUser(...args),
  };
});

vi.mock("./frontier-editions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./frontier-editions")>();

  return {
    ...actual,
    getFrontierEdition: (...args: unknown[]) => getFrontierEdition(...args),
    getFrontierEditions: (...args: unknown[]) => getFrontierEditions(...args),
  };
});

const USER = { createdAt: "2026-01-01T00:00:00.000Z", id: "user-1", username: "fan" };

const SUMMARY = { number: 3, refreshedAt: "2026-11-23T06:00:00.000Z", trackCount: 1 };

const TRACK = {
  artists: ["Ashen Relay"],
  slot: "finding" as const,
  title: "Low Orbit",
  trackId: "track-1",
};

function get(path: string): Request {
  return new Request(apiUrl(path), { method: "GET" });
}

warmOrpcRouter();

beforeEach(() => {
  requirePublicUser.mockReset();
  getFrontierEdition.mockReset();
  getFrontierEditions.mockReset();
  requirePublicUser.mockResolvedValue(USER);
});

describe("GET /me/frontier-editions/{number} (get_private_frontier_edition)", () => {
  it("returns the signed-in user's edition by number", async () => {
    getFrontierEdition.mockResolvedValue({ summary: SUMMARY, tracks: [TRACK] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("/me/frontier-editions/3"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ edition: SUMMARY, ok: true, tracks: [TRACK] });
    expect(getFrontierEdition).toHaveBeenCalledWith("user-1", 3);
  });

  it.each(["0", "-1", "abc"])(
    "404s edition_not_found for the impossible number %s without reading editions",
    async (number) => {
      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(get(`/me/frontier-editions/${number}`));

      expect(response?.status).toBe(404);
      expect(await readJson(response)).toMatchObject({
        code: "frontier_edition_not_found",
        ok: false,
      });
      expect(getFrontierEdition).not.toHaveBeenCalled();
    },
  );

  it("404s edition_not_found when the user holds no edition with that number", async () => {
    getFrontierEdition.mockResolvedValue(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("/me/frontier-editions/9"));

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toMatchObject({
      code: "frontier_edition_not_found",
      ok: false,
    });
    expect(getFrontierEdition).toHaveBeenCalledWith("user-1", 9);
  });

  it("refuses a signed-out request before reading editions", async () => {
    requirePublicUser.mockResolvedValue(
      Response.json(
        { code: "auth_required", message: "Sign in to use this private account route", ok: false },
        { status: 401 },
      ),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("/me/frontier-editions/3"));

    expect(response?.status).toBe(401);
    expect(await readJson(response)).toMatchObject({ code: "auth_required", ok: false });
    expect(getFrontierEdition).not.toHaveBeenCalled();
  });
});

describe("GET /me/frontier-editions (list_private_frontier_editions)", () => {
  it("lists only the signed-in user's editions", async () => {
    getFrontierEditions.mockResolvedValue([SUMMARY]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("/me/frontier-editions"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ editions: [SUMMARY], ok: true });
    expect(getFrontierEditions).toHaveBeenCalledWith("user-1");
  });

  it("refuses a signed-out request before listing editions", async () => {
    requirePublicUser.mockResolvedValue(
      Response.json(
        { code: "auth_required", message: "Sign in to use this private account route", ok: false },
        { status: 401 },
      ),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("/me/frontier-editions"));

    expect(response?.status).toBe(401);
    expect(getFrontierEditions).not.toHaveBeenCalled();
  });

  it("answers a failed edition read with a server fault, not an empty list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    getFrontierEditions.mockRejectedValue(new Error("database unavailable"));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("/me/frontier-editions"));

    expect(response?.status).toBe(500);
    expect(await readJson(response)).toEqual({
      code: "error",
      message: "Internal error",
      ok: false,
    });
  });
});

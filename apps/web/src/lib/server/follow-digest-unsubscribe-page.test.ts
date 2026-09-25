import { describe, expect, it } from "vitest";
import { serverHandlers } from "../../routes/api/v1/follow-digest/unsubscribe";

describe("follow digest unsubscribe link opened in a browser", () => {
  it("hands the signed token to the /follows page without a referrer", async () => {
    const response = await serverHandlers.GET({
      request: new Request("https://www.fluncle.com/api/v1/follow-digest/unsubscribe?token=a.b.c"),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/follows?unsubscribe=a.b.c");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("still lands on the page when the token is missing", async () => {
    const response = await serverHandlers.GET({
      request: new Request("https://www.fluncle.com/api/v1/follow-digest/unsubscribe"),
    });

    expect(response.headers.get("Location")).toBe("/follows");
  });
});

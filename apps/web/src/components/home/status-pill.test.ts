import { describe, expect, it } from "vitest";
import { derivePillState, pillLabel, type StatusService } from "./status-pill";

// The home status pill reads /api/status and collapses the services list into one
// quiet footer signal. The derivation is the load-bearing part — the loudest
// status wins, the count is the number of services that aren't ok, an empty/absent
// list stays neutral (never falsely "operational"), and the copy stays terse and
// on-voice. Test it in isolation; the fetch wiring is a thin best-effort wrapper.

function svc(status: StatusService["status"]): StatusService {
  return { status };
}

describe("derivePillState", () => {
  it("is neutral (loading) when nothing is reporting yet", () => {
    expect(derivePillState([])).toEqual({ tone: "loading" });
  });

  it("is ok when every service is operational", () => {
    expect(derivePillState([svc("ok"), svc("ok"), svc("ok")])).toEqual({ tone: "ok" });
  });

  it("counts the services that aren't ok", () => {
    expect(derivePillState([svc("ok"), svc("degraded"), svc("degraded")])).toEqual({
      count: 2,
      tone: "degraded",
    });
  });

  it("lets down beat degraded for the headline tone", () => {
    expect(derivePillState([svc("ok"), svc("degraded"), svc("down")])).toEqual({
      count: 2,
      tone: "down",
    });
  });

  it("reports down with its own count when only services are down", () => {
    expect(derivePillState([svc("down"), svc("ok")])).toEqual({ count: 1, tone: "down" });
  });
});

describe("pillLabel", () => {
  it("rests quiet while loading", () => {
    expect(pillLabel({ tone: "loading" })).toBe("checking systems");
  });

  it("reads all-clear when ok", () => {
    expect(pillLabel({ tone: "ok" })).toBe("all systems operational");
  });

  it("singularizes a single off service", () => {
    expect(pillLabel({ count: 1, tone: "degraded" })).toBe("1 system degraded");
  });

  it("pluralizes multiple off services and names the worst verb", () => {
    expect(pillLabel({ count: 3, tone: "down" })).toBe("3 systems down");
  });
});

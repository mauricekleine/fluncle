import { describe, expect, it } from "vitest";
import { isLogPageParam } from "@/lib/log-page-param";
import { Route as StoriesIndexRoute } from "./stories.index";
import { Route as StoryRoute } from "./stories.$logId";

// The /stories → /log moves: dumb 301 passthroughs. Normalization happens
// once, at /log, so a canonical-coordinate link never chains 301→301.

type ThrownRedirect = {
  options?: { params?: unknown; statusCode?: number; to?: string };
  params?: unknown;
  statusCode?: number;
  to?: string;
};

function captureRedirect(run: () => unknown): {
  params?: unknown;
  statusCode?: number;
  to?: string;
} {
  try {
    run();
  } catch (thrown) {
    const redirect = thrown as ThrownRedirect;
    const source = redirect.options ?? redirect;

    return { params: source.params, statusCode: source.statusCode, to: source.to };
  }

  throw new Error("expected a redirect to be thrown");
}

describe("/stories/$logId → /log/$logId", () => {
  it("301s with the param passed through untouched (dumb passthrough)", () => {
    const redirect = captureRedirect(() =>
      StoryRoute.options.beforeLoad?.({ params: { logId: "004.7.2I" } } as never),
    );

    expect(redirect.to).toBe("/log/$logId");
    expect(redirect.statusCode).toBe(301);
    expect(redirect.params).toEqual({ logId: "004.7.2I" });
  });

  it("never chains for a canonical coordinate: the /log target accepts it directly", () => {
    const redirect = captureRedirect(() =>
      StoryRoute.options.beforeLoad?.({ params: { logId: "004.7.2I" } } as never),
    );
    const forwardedParam = (redirect.params as { logId: string }).logId;

    // The /log guard admits the forwarded param without another redirect hop
    // (only a legacy trackId pays one more hop, at /log, where normalization
    // lives).
    expect(isLogPageParam(forwardedParam)).toBe(true);
  });

  it("forwards a legacy trackId verbatim (normalized once, at /log)", () => {
    const redirect = captureRedirect(() =>
      StoryRoute.options.beforeLoad?.({ params: { logId: "6Y44zcYp0vUkmKCBve1Epr" } } as never),
    );

    expect(redirect.params).toEqual({ logId: "6Y44zcYp0vUkmKCBve1Epr" });
  });
});

describe("/stories → /log", () => {
  it("301s the index", () => {
    const redirect = captureRedirect(() => StoriesIndexRoute.options.beforeLoad?.({} as never));

    expect(redirect.to).toBe("/log");
    expect(redirect.statusCode).toBe(301);
  });
});

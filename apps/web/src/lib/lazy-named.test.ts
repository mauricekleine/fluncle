import { describe, expect, it } from "vitest";
import { isStaleBuildError } from "./stale-build-recovery";
import { lazyNamed } from "./lazy-named";

type LazyInit = { _init: (payload: unknown) => unknown; _payload: unknown };

async function resolveLazy(component: unknown): Promise<unknown> {
  const lazyComponent = component as LazyInit;

  try {
    return lazyComponent._init(lazyComponent._payload);
  } catch (thrown) {
    if (thrown instanceof Promise) {
      await thrown.catch(() => undefined);

      return lazyComponent._init(lazyComponent._payload);
    }

    throw thrown;
  }
}

describe("lazyNamed", () => {
  it("resolves the named export", async () => {
    const Named = () => null;
    const component = lazyNamed(async () => ({ Named }), "Named");

    await expect(resolveLazy(component)).resolves.toBe(Named);
  });

  it("turns a swallowed chunk failure into a stale-build error", async () => {
    const component = lazyNamed(
      async () => undefined as { Named: () => null } | undefined,
      "Named",
    );

    let caught: unknown;

    try {
      await resolveLazy(component);
    } catch (error) {
      caught = error;
    }

    expect(isStaleBuildError(caught)).toBe(true);
  });
});

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  imageTransformFallbackScript,
  MANAGED_FALLBACK_ATTRIBUTE,
} from "./image-transform-fallback";
import { labelLogoUrl } from "./media";

type Listener = (event: { target: unknown }) => void;

function runShippedScript(): { capture: boolean; fire: (target: unknown) => void } {
  let listener: Listener | undefined;
  let capture = false;
  const fakeDocument = {
    addEventListener: (_type: string, handler: Listener, useCapture: boolean) => {
      listener = handler;
      capture = useCapture;
    },
  };

  runInNewContext(imageTransformFallbackScript, { document: fakeDocument });

  return {
    capture,
    fire: (target) => listener?.({ target }),
  };
}

function fakeImage(src: string, currentSrc = src) {
  const attributes = new Set(["srcset", "sizes"]);

  return {
    attributes,
    currentSrc,
    hasAttribute: (name: string) => attributes.has(name),
    removeAttribute: (name: string) => attributes.delete(name),
    src,
    tagName: "IMG",
  };
}

describe("image transform fallback script", () => {
  const logo = labelLogoUrl("labels/a-tech.jpg", "2026-11-21T08:00:00.000Z", "small");
  const source = logo?.slice(logo.indexOf("https://", 1));

  it("listens in the capture phase, since image errors do not bubble", () => {
    expect(runShippedScript().capture).toBe(true);
  });

  it("swaps a refused Cloudflare transform for its owned source and drops the srcset", () => {
    const { fire } = runShippedScript();
    const image = fakeImage(logo ?? "");

    fire(image);

    expect(source).toMatch(/^https:\/\/found\.fluncle\.com\/labels\/a-tech\.jpg\?v=\d+$/);
    expect(image.src).toBe(source);
    expect([...image.attributes]).toEqual([]);
  });

  it("falls back from the srcset candidate the browser picked, percent-encoded options included", () => {
    const { fire } = runShippedScript();
    const candidate = `https://found.fluncle.com/cdn-cgi/image/width=300%2Cformat=auto/${source}`;
    const image = fakeImage(logo ?? "", candidate);

    fire(image);

    expect(image.src).toBe(source);
  });

  it("leaves images that are not Cloudflare transforms alone, so a failed source cannot loop", () => {
    const { fire } = runShippedScript();
    const image = fakeImage(source ?? "");

    fire(image);

    expect(image.src).toBe(source);
    expect([...image.attributes]).toEqual(["srcset", "sizes"]);
  });

  it("leaves images that manage their own fallback to their component", () => {
    const { fire } = runShippedScript();
    const image = fakeImage(logo ?? "");
    image.attributes.add(MANAGED_FALLBACK_ATTRIBUTE);

    fire(image);

    expect(image.src).toBe(logo);
  });

  it("ignores errors from elements other than images", () => {
    const { fire } = runShippedScript();
    const video = { ...fakeImage(logo ?? ""), tagName: "VIDEO" };

    fire(video);
    fire(null);

    expect(video.src).toBe(logo);
  });
});

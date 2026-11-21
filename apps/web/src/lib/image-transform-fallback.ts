type FallbackImage = {
  currentSrc?: string;
  hasAttribute: (name: string) => boolean;
  removeAttribute: (name: string) => void;
  src: string;
  tagName?: string;
};

type ErrorTarget = {
  fluncleImageTransformFallback?: boolean;
  addEventListener: (
    type: "error",
    listener: (event: { target: unknown }) => void,
    capture: boolean,
  ) => void;
};

export const MANAGED_FALLBACK_ATTRIBUTE = "data-managed-fallback";

export function imageTransformSource(url: string | undefined): string | undefined {
  const marker = "/cdn-cgi/image/";
  const at = url ? url.indexOf(marker) : -1;

  if (!url || at === -1) {
    return undefined;
  }

  const transformed = url.slice(at + marker.length);
  const sourceStart = transformed.indexOf("/");

  return sourceStart === -1 ? undefined : transformed.slice(sourceStart + 1);
}

export function installImageTransformFallback(
  root: ErrorTarget,
  sourceOf: (url: string | undefined) => string | undefined,
  managedAttribute: string,
): void {
  if (root.fluncleImageTransformFallback) {
    return;
  }

  root.fluncleImageTransformFallback = true;

  root.addEventListener(
    "error",
    (event) => {
      const image = event.target as FallbackImage | null;

      if (!image || image.tagName !== "IMG" || image.hasAttribute(managedAttribute)) {
        return;
      }

      const source = sourceOf(image.currentSrc || image.src);

      if (!source) {
        return;
      }

      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
      image.src = source;
    },
    true,
  );
}

export const imageTransformFallbackScript = `(${installImageTransformFallback.toString()})(document, ${imageTransformSource.toString()}, ${JSON.stringify(MANAGED_FALLBACK_ATTRIBUTE)});`;

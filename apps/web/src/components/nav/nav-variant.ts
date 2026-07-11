// The variation machinery for the public-nav exploration: four architectures for
// ONE navModel, a dev-only picker to flip between them live, and the prod-safety
// contract that keeps prod pinned to variant A until the operator picks.
//
// The decision logic is a PURE function (`resolveActiveVariant`) so its prod-safety
// — prod ALWAYS renders A, ignoring any stored choice — is unit-testable without a
// browser. The picker itself is gated at its call site by a LITERAL
// `import.meta.env.DEV` (public-chrome.tsx), which Vite replaces with `false` in the
// production build, so rollup dead-eliminates the picker component and its imports;
// its CSS is colocated inside the component so it disappears with it.

/** The four navigation architectures. A is the shipped default. */
export type NavVariant = "A" | "B" | "C" | "D";

export const NAV_VARIANTS: readonly NavVariant[] = ["A", "B", "C", "D"] as const;

/** The default rendered everywhere until the operator picks another on localhost. */
export const DEFAULT_NAV_VARIANT: NavVariant = "A";

/** The localStorage key the dev picker persists the operator's choice under. */
export const NAV_VARIANT_STORAGE_KEY = "fluncle:nav-variant";

/** Each variant's short name + thesis — shown in the picker, documented in the PR. */
export const NAV_VARIANT_META: Record<NavVariant, { name: string; thesis: string }> = {
  A: {
    name: "Masthead strip",
    thesis:
      "A quiet sticky top strip carries the primary Explore nav on every page; the shared footer holds full link equity. The everyday driver — the trunk is always one glance away.",
  },
  B: {
    name: "Logbook colophon",
    thesis:
      "Chrome up top shrinks to just the wordmark; the navigation weight moves to a large, plate-grammar footer read like a record sleeve's liner notes. Keeps the cover the hero, banks the crawl equity at the bottom.",
  },
  C: {
    name: "Left rail",
    thesis:
      "A persistent left spine on wide viewports (wordmark, vertical Explore, the quiet rows sunk to the bottom) that collapses to a top header on narrow screens. The archive as an app with a fixed trunk.",
  },
  D: {
    name: "Chart drawer",
    thesis:
      "One compact trigger opens a full navigation plate with every section AND archive search — the page stays uncluttered while the whole graph (and hundreds of artists) is one tap and one query away. Built for the larger catalog.",
  },
};

function isNavVariant(value: unknown): value is NavVariant {
  return typeof value === "string" && (NAV_VARIANTS as readonly string[]).includes(value);
}

/**
 * Decide which variant to render. THE prod-safety gate:
 * - In production (`isDev: false`) it ALWAYS returns the default (A), ignoring any
 *   stored value — so a stray localStorage entry can never change what ships.
 * - In dev it honours a valid stored choice, else falls back to the default.
 */
export function resolveActiveVariant({
  isDev,
  stored,
}: {
  isDev: boolean;
  stored: string | null;
}): NavVariant {
  if (!isDev) {
    return DEFAULT_NAV_VARIANT;
  }

  return isNavVariant(stored) ? stored : DEFAULT_NAV_VARIANT;
}

/** Read the persisted choice (browser only; SSR + prod return null → default A). */
export function readStoredVariant(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(NAV_VARIANT_STORAGE_KEY);
  } catch {
    // Private-mode / disabled storage: fall back to the default rather than throw.
    return null;
  }
}

/** Persist the operator's pick (dev only; best-effort). */
export function writeStoredVariant(variant: NavVariant): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(NAV_VARIANT_STORAGE_KEY, variant);
  } catch {
    // Ignore storage failures — the choice just won't persist across reloads.
  }
}

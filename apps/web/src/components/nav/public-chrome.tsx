// The ONE mount point for the public navigation. Wraps every public page (mounted
// once in __root.tsx, inside the QueryClientProvider) with the operator-selected
// variant's chrome, and renders the dev-only picker. Admin and a few full-bleed
// immersive surfaces opt out entirely.
//
// Prod-safety: SSR and production both render variant A. Every dev-only branch is
// guarded by a LITERAL `import.meta.env.DEV` (never a helper call) — Vite replaces it
// with `false` in the prod build, so rollup dead-code-eliminates both the branch and
// the `VariantPicker` import, and the picker is verifiably absent from the prod
// bundle (its CSS is colocated in the component for the same reason). In dev the
// operator's stored pick applies after mount.

import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
  DEFAULT_NAV_VARIANT,
  type NavVariant,
  readStoredVariant,
  resolveActiveVariant,
} from "@/components/nav/nav-variant";
import { useGalaxiesLive } from "@/components/nav/use-galaxies-live";
import { VariantColophon } from "@/components/nav/variant-colophon";
import { VariantDrawer } from "@/components/nav/variant-drawer";
import { VariantMasthead } from "@/components/nav/variant-masthead";
import { VariantPicker } from "@/components/nav/variant-picker";
import { VariantRail } from "@/components/nav/variant-rail";

// Surfaces that render WITHOUT the public chrome:
// - /admin: its own AdminShell workspace chrome (never touched here).
// - /radio, /galaxy: full-bleed immersive experiences (the player, the game canvas).
// - /device, /cli: bare auth / install flows.
const CHROMELESS_PREFIXES = ["/admin", "/radio", "/galaxy", "/device", "/cli"];

function isChromeless(pathname: string): boolean {
  return CHROMELESS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const VARIANTS: Record<
  NavVariant,
  (props: { children: ReactNode; galaxiesLive: boolean; pathname: string }) => ReactNode
> = {
  A: VariantMasthead,
  B: VariantColophon,
  C: VariantRail,
  D: VariantDrawer,
};

export function PublicChrome({ children }: { children: ReactNode }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const galaxiesLive = useGalaxiesLive();

  // SSR + prod pin to A; in dev, read the operator's stored pick after mount (a brief
  // dev-only flash to the chosen variant, never in prod).
  const [variant, setVariant] = useState<NavVariant>(DEFAULT_NAV_VARIANT);

  useEffect(() => {
    // A literal DEV guard, so this whole body is eliminated from the prod bundle.
    if (!import.meta.env.DEV) {
      return;
    }

    setVariant(resolveActiveVariant({ isDev: true, stored: readStoredVariant() }));
  }, []);

  if (isChromeless(pathname)) {
    return <>{children}</>;
  }

  const Variant = VARIANTS[variant];

  return (
    <>
      <Variant galaxiesLive={galaxiesLive} pathname={pathname}>
        {children}
      </Variant>
      {import.meta.env.DEV ? <VariantPicker onChange={setVariant} value={variant} /> : undefined}
    </>
  );
}

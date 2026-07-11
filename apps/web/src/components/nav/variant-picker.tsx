// The dev-only variation picker — a small floating switcher that flips the public
// nav between the four architectures live on ANY public page, persisting the choice
// to localStorage.
//
// It is rendered ONLY behind a literal `import.meta.env.DEV` (public-chrome.tsx),
// which Vite replaces with `false` in the prod build, so rollup dead-eliminates this
// module entirely. Its CSS is COLOCATED here (an inline <style>, not styles.css) for
// exactly that reason: the whole picker — markup, logic, and styling — leaves no
// trace in the production bundle. Verified by grepping `dist/` for `nav-picker`.

import { type ReactNode } from "react";
import {
  NAV_VARIANTS,
  NAV_VARIANT_META,
  type NavVariant,
  writeStoredVariant,
} from "@/components/nav/nav-variant";

const pickerCss = `
.nav-picker {
  align-items: center;
  backdrop-filter: blur(12px) saturate(125%);
  background: color-mix(in oklch, var(--sleeve-black) 84%, transparent);
  border: 1px solid var(--border);
  border-radius: 999px;
  bottom: 1rem;
  display: flex;
  gap: 0.25rem;
  left: 1rem;
  padding: 0.3rem 0.5rem;
  position: fixed;
  z-index: 60;
}
.nav-picker-label {
  color: var(--stardust);
  font-family: "Monaspace Krypton", ui-monospace, monospace;
  font-size: 0.68rem;
  text-transform: uppercase;
}
.nav-picker-btn {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--muted-foreground);
  cursor: pointer;
  font-family: "Oxanium", ui-sans-serif, sans-serif;
  font-size: 0.78rem;
  font-weight: 700;
  height: 1.6rem;
  transition: color 150ms ease-out, background-color 150ms ease-out;
  width: 1.6rem;
}
.nav-picker-btn:hover { color: var(--eclipse-glow); }
.nav-picker-btn--active { background: var(--eclipse-gold); color: var(--ink-on-gold, #151006); }
.nav-picker-name {
  color: var(--stardust);
  font-size: 0.7rem;
  padding: 0 0.35rem 0 0.15rem;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .nav-picker-btn { transition: none; }
}
`;

export function VariantPicker({
  onChange,
  value,
}: {
  onChange: (variant: NavVariant) => void;
  value: NavVariant;
}): ReactNode {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: pickerCss }} />
      <div aria-label="Navigation variant picker (dev only)" className="nav-picker" role="group">
        <span className="nav-picker-label">nav</span>
        {NAV_VARIANTS.map((variant) => (
          <button
            aria-pressed={variant === value}
            className={`nav-picker-btn${variant === value ? " nav-picker-btn--active" : ""}`}
            key={variant}
            onClick={() => {
              writeStoredVariant(variant);
              onChange(variant);
            }}
            title={`${variant} — ${NAV_VARIANT_META[variant].name}: ${NAV_VARIANT_META[variant].thesis}`}
            type="button"
          >
            {variant}
          </button>
        ))}
        <span className="nav-picker-name">{NAV_VARIANT_META[value].name}</span>
      </div>
    </>
  );
}

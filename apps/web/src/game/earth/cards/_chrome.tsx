import { type ReactNode } from "react";
import { earthPalette as c } from "../palette";

// Shared card chrome — the warm-dark panel every door opens onto, plus the three
// card BODIES (link, gated, terminal). Canon rails: dark-only, cream ink at AA
// over the grain (opacity is the lever, not dimmer text), gold that HEATS on
// interaction (Ignition Rule), "surface" not "room", no exclamation marks, no
// em dashes, sentence case (ALL CAPS only for a brand-mark plate). The overlay
// backdrop + the esc affordance + focus management live in the route; a card
// renders only its panel.

export function CardShell({
  accent = c.gold,
  children,
  label,
}: {
  accent?: string;
  children: ReactNode;
  label: string;
}) {
  return (
    <div
      aria-label={label}
      aria-modal="true"
      className="w-full max-w-md rounded-md p-7 shadow-2xl"
      role="dialog"
      style={{ background: c.sleeveBlack, border: `1px solid ${accent}`, color: c.cream }}
    >
      {children}
    </div>
  );
}

// A destination: a title, a said-not-written blurb, a gold CTA that heats on
// hover/focus. The CTA is a real link (an owned route, a channel, a subdomain).
export function LinkBody({
  blurb,
  cta,
  title,
}: {
  blurb: string;
  cta: { href: string; label: string };
  title: string;
}) {
  return (
    <div className="text-center">
      <p className="text-lg" style={{ color: c.creamBright }}>
        {title}
      </p>
      <p className="mt-2 text-sm" style={{ color: c.creamMuted }}>
        {blurb}
      </p>
      <a
        className="earth-cta mt-5 inline-block rounded-full px-5 py-2 text-sm font-medium"
        href={cta.href}
        rel="noreferrer"
        style={{ border: `1px solid ${c.gold}`, color: c.goldBright }}
        target="_blank"
      >
        {cta.label}
      </a>
      <style>{`.earth-cta{transition:background-color .15s,color .15s}.earth-cta:hover,.earth-cta:focus-visible{background:${c.gold};color:${c.inkOnGold};outline:none}`}</style>
    </div>
  );
}

// A surface the player can reach only by command (the CLI, the SSH terminal, the
// dig zone): show the invocation as code, not a link.
export function CommandBody({
  blurb,
  commands,
  title,
}: {
  blurb: string;
  commands: string[];
  title: string;
}) {
  return (
    <div>
      <p className="text-center text-lg" style={{ color: c.creamBright }}>
        {title}
      </p>
      <p className="mt-2 text-center text-sm" style={{ color: c.creamMuted }}>
        {blurb}
      </p>
      <div
        className="mt-4 rounded p-3 font-mono text-xs leading-relaxed"
        style={{ background: c.tapeBlack, color: c.cream }}
      >
        {commands.map((line) => (
          <p key={line}>
            <span style={{ color: c.goldBright }}>$</span> {line}
          </p>
        ))}
      </div>
    </div>
  );
}

// A surface that exists but isn't live yet (mobile, the Lens, the Discord
// server): honest, no CTA.
export function GatedBody({ blurb, title }: { blurb: string; title: string }) {
  return (
    <div className="text-center">
      <p className="text-lg" style={{ color: c.creamBright }}>
        {title}
      </p>
      <p className="mt-2 text-sm" style={{ color: c.creamMuted }}>
        {blurb}
      </p>
      <span
        className="mt-5 inline-block rounded-full px-4 py-1 text-xs"
        style={{ border: `1px solid ${c.creamDim}`, color: c.creamMuted }}
      >
        not landed yet
      </span>
    </div>
  );
}

// The recovered CRT terminal — recolored off the spike's green field (Retint
// Rule): warm-dark, cream ink, a gold prompt, a dim-teal phosphor ghost, and
// scanlines carrying the CRT feel. The SSH door's payload.
export function TerminalBody({ host }: { host: string }) {
  return (
    <div
      className="relative w-full max-w-2xl overflow-hidden rounded-md p-6 font-mono text-sm leading-relaxed shadow-2xl"
      style={{ background: c.tapeBlack, border: `1px solid ${c.coolTeal}`, color: c.cream }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.30) 0px, rgba(0,0,0,0.30) 1px, transparent 2px, transparent 4px)",
        }}
      />
      <p style={{ color: c.coolTeal }}>fluncle terminal · recovered shell</p>
      <p>[ ok ] tailnet up</p>
      <p>[ ok ] tor: onion published</p>
      <p>[ ok ] wish: listening</p>
      <p className="mt-3" style={{ color: c.creamMuted }}>
        a terminal at the edge of the map. drop in from your own machine:
      </p>
      <p className="mt-2">
        <span style={{ color: c.goldBright }}>$</span> ssh {host}
        <span className="earth-caret">▋</span>
      </p>
      <style>{`.earth-caret{color:${c.coolTeal};animation:earthcb 1s steps(1) infinite}@keyframes earthcb{50%{opacity:0}}`}</style>
    </div>
  );
}

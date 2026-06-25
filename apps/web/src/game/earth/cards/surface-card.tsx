import { type Surface, SURFACES } from "@fluncle/registry";
import { siteUrl } from "@/lib/fluncle-links";
import { earthPalette as c } from "../palette";
import { CardShell, CommandBody, LinkBody } from "./_chrome";

// The generic card for an OWNED surface: it reads its blurb + destination from
// @fluncle/registry (#165) — the single source of truth — so a door never
// hardcodes a URL or drifts from canon. Web routes + subdomains + the MCP server
// render a link; command-only surfaces (the CLI, the SSH zone, dig) render the
// invocation as code.

export function findSurface(name: string): Surface | undefined {
  return SURFACES.find((surface) => surface.name === name);
}

function destination(surface: Surface): string | undefined {
  if (surface.url) {
    return surface.url;
  }
  if (surface.subdomain) {
    return `https://${surface.subdomain}`;
  }
  if (surface.route) {
    return `${siteUrl}${surface.route}`;
  }
  return undefined;
}

export function SurfaceCard({ label, surface }: { label: string; surface: Surface }) {
  // The door label is the in-world map-pin (lowercase); a card heading is sentence
  // case (VOICE.md §6), so capitalize the first letter for the title. The registry's
  // exposedContent is authored for a doctrine doc and can carry prose em dashes,
  // which the game's voice rails ban; normalize them to a colon for display.
  const title = label.length === 0 ? label : label.charAt(0).toUpperCase() + label.slice(1);
  const blurb = (surface.exposedContent[0] ?? "").replace(/\s*—\s*/g, ": ");
  const href = destination(surface);

  if (href) {
    return (
      <CardShell label={label}>
        <LinkBody blurb={blurb} cta={{ href, label: "open" }} title={title} />
      </CardShell>
    );
  }

  if (surface.command) {
    return (
      <CardShell accent={c.coolTeal} label={label}>
        <CommandBody blurb={blurb} commands={[surface.command]} title={title} />
      </CardShell>
    );
  }

  return (
    <CardShell label={label}>
      <LinkBody blurb={blurb} cta={{ href: siteUrl, label: "open fluncle.com" }} title={title} />
    </CardShell>
  );
}

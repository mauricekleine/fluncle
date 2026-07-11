// Shared renderers that turn a NavItem into the right element — a crawlable
// internal `<a>` (TanStack `<Link>`), an off-site `<a>`, or a dialog CTA — so all
// four variants render one item identically and differ only in layout/architecture.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { navIcon } from "@/components/nav/nav-icons";
import { SubmitTrackDialog } from "@/components/submit-track-dialog";
import { SubscribeDialog } from "@/components/subscribe-dialog";
import { type NavItem } from "@/lib/nav-model";
import { cn } from "@/lib/utils";

/**
 * An internal route link. The nav model carries `to` as a plain string (data-driven
 * nav), so we cast at the single `<Link>` boundary — the string is a valid app route
 * (asserted by the nav-model completeness test), and TanStack builds the real `<a
 * href>` from it at runtime regardless of the compile-time union.
 */
export function NavRouteLink({
  children,
  className,
  params,
  to,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  params?: Record<string, string>;
  to: string;
}): ReactNode {
  return (
    <Link
      activeOptions={{ exact: to === "/" }}
      activeProps={{ "aria-current": "page", "data-status": "active" }}
      className={className}
      params={params as never}
      to={to as never}
      {...rest}
    >
      {children}
    </Link>
  );
}

/** An off-site link — always a real `<a>` opening in a new tab, safe `rel`. */
export function NavExternalLink({
  children,
  className,
  href,
  label,
}: {
  children: ReactNode;
  className?: string;
  href: string;
  label?: string;
}): ReactNode {
  return (
    <a aria-label={label} className={className} href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

/**
 * Render one NavItem as an icon + label link (route or external). Action items are
 * handled by `NavActionItem` (they need their dialog), so this returns null for
 * them — callers render actions separately.
 */
export function NavItemLink({
  className,
  item,
  showIcon = true,
}: {
  className?: string;
  item: NavItem;
  showIcon?: boolean;
}): ReactNode {
  const inner = (
    <>
      {showIcon ? navIcon(item.id) : undefined}
      <span>{item.label}</span>
    </>
  );

  // A future (not-yet-shipped) slot: shown as a disabled label with a "soon" tag so
  // the architecture is visible, never a live link that 404s.
  if (item.future) {
    return (
      <span
        aria-disabled="true"
        className={cn("nav-item nav-item--soon", className)}
        title="Coming soon"
      >
        {showIcon ? navIcon(item.id) : undefined}
        <span>{item.label}</span>
        <span className="nav-soon-tag">soon</span>
      </span>
    );
  }

  if (item.kind === "route") {
    return (
      <NavRouteLink className={cn("nav-item", className)} params={item.params} to={item.to}>
        {inner}
      </NavRouteLink>
    );
  }

  if (item.kind === "external") {
    return (
      <NavExternalLink className={cn("nav-item", className)} href={item.href} label={item.label}>
        {inner}
      </NavExternalLink>
    );
  }

  return undefined;
}

/** Render an `action` NavItem as its dialog CTA (submit a track / subscribe). */
export function NavActionItem({
  className,
  item,
}: {
  className?: string;
  item: NavItem;
}): ReactNode {
  if (item.kind !== "action") {
    return undefined;
  }

  if (item.action === "submit") {
    return <SubmitTrackDialog className={className} />;
  }

  return <SubscribeDialog className={className} label={item.label} />;
}

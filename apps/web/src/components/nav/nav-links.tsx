import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { navIcon } from "@/components/nav/nav-icons";
import { type NavItem } from "@/lib/nav-model";
import { cn } from "@/lib/utils";

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

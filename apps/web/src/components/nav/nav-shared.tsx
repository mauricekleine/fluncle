// Small pieces shared across the variant headers/rails: the wordmark and the
// identity CTAs. The ONE gold sun is the Galaxy CTA (DESIGN.md One Sun); Join the
// crew and Submit stay quiet outline controls so nothing competes with it.

import { UsersThreeIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { HomeStatusPill } from "@/components/home/status-pill";
import { navIcon } from "@/components/nav/nav-icons";
import { NavItemLink } from "@/components/nav/nav-links";
import { SubmitTrackDialog } from "@/components/submit-track-dialog";
import { Button } from "@fluncle/ui/components/button";
import {
  navFollow,
  navNerds,
  navPrimaryCta,
  navSections,
  renderableItems,
  type NavSection,
} from "@/lib/nav-model";

/** The brand wordmark — links home, set in Oxanium via `.nav-wordmark`. */
export function NavWordmark({ className }: { className?: string }): ReactNode {
  return (
    <Link aria-label="Fluncle home" className={className ?? "nav-wordmark"} to="/">
      FLUNCLE
    </Link>
  );
}

/** The Galaxy gold CTA (the one sun) + Submit + Join the crew. */
export function NavPrimaryActions({ compact = false }: { compact?: boolean }): ReactNode {
  const size = compact ? "sm" : "default";

  return (
    <div className="nav-actions">
      <Button
        className="nav-galaxy-cta"
        nativeButton={false}
        render={<a aria-label="Enter Fluncle's Galaxy" href={navPrimaryCta.galaxy.href} />}
        size={size}
      >
        <img
          alt=""
          aria-hidden="true"
          className="size-4 object-contain [image-rendering:pixelated]"
          src="/galaxy/ship.png"
        />
        <span className="nav-actions-label">Galaxy</span>
      </Button>
      <SubmitTrackDialog compact={compact} />
      <Button
        className="nav-join-cta"
        nativeButton={false}
        render={<Link aria-label="Join the crew" to="/account" />}
        size={size}
        variant="outline"
      >
        <UsersThreeIcon aria-hidden="true" weight="bold" />
        <span className="nav-actions-label">Join the crew</span>
      </Button>
    </div>
  );
}

/** A section rendered as an inline row of icon + label links (the strip/rail nav). */
export function NavSectionRow({
  className,
  galaxiesLive,
  section,
  showIcon = true,
}: {
  className?: string;
  galaxiesLive: boolean;
  section: NavSection;
  showIcon?: boolean;
}): ReactNode {
  const items = renderableItems(section, galaxiesLive).filter((item) => item.kind !== "action");

  return (
    <nav aria-label={section.label} className={className}>
      {items.map((item) => (
        <NavItemLink item={item} key={item.id} showIcon={showIcon} />
      ))}
    </nav>
  );
}

/** The quiet rows (Follow + For the nerds + the live status pill) for the rail/drawer. */
export function NavQuietRows(): ReactNode {
  return (
    <div className="nav-quietrows">
      <div className="nav-quietrow">
        <span className="nav-footer-rowlabel">Follow Fluncle</span>
        <nav aria-label="Fluncle on other platforms" className="nav-follow">
          {navFollow.map((social) => (
            <a
              aria-label={social.label}
              className="nav-follow-link"
              href={social.href}
              key={social.id}
              rel="noreferrer"
              target="_blank"
            >
              {navIcon(social.id)}
            </a>
          ))}
        </nav>
      </div>
      <div className="nav-quietrow">
        <span className="nav-footer-rowlabel">For the nerds</span>
        <nav aria-label="Developer surfaces" className="nav-nerds">
          {navNerds.map((nerd) =>
            nerd.kind === "external" ? (
              <a
                className="nav-nerd-link"
                href={nerd.href}
                key={nerd.id}
                rel="noreferrer"
                target="_blank"
              >
                {nerd.label}
              </a>
            ) : (
              <Link
                className="nav-nerd-link"
                key={nerd.id}
                params={{ _splat: nerd.splat }}
                to="/docs/$"
              >
                {nerd.label}
              </Link>
            ),
          )}
        </nav>
      </div>
      <HomeStatusPill />
    </div>
  );
}

const EXPLORE_SECTION = navSections.find((section) => section.id === "explore");

/** The Explore section (the primary nav in most variants). */
export function exploreSection(): NavSection {
  if (!EXPLORE_SECTION) {
    throw new Error("nav model is missing its Explore section");
  }

  return EXPLORE_SECTION;
}

/** Every section (Explore, Listen, Crew) for the rail/drawer sitemap views. */
export function allSections(): NavSection[] {
  return navSections;
}

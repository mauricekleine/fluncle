// The shared site footer — the crawl backbone every variant renders, so any deep
// page is within two hops of every index (log ↔ artists ↔ galaxies ↔ logbook ↔
// mixtapes ↔ labels-soon), which is where a footer earns its SEO keep. Two looks:
// `plain` (a quiet field, the default the strip/rail/drawer variants use) and
// `colophon` (the plate grammar — crop-mark brackets + register cross, the star of
// variant B). Same links either way; only the chrome differs.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { HomeStatusPill } from "@/components/home/status-pill";
import { navIcon } from "@/components/nav/nav-icons";
import { NavItemLink } from "@/components/nav/nav-links";
import {
  navDocsHome,
  navFollow,
  navNerds,
  navSections,
  renderableItems,
  type NavSection,
} from "@/lib/nav-model";
import { cn } from "@/lib/utils";

function FooterColumn({
  galaxiesLive,
  section,
}: {
  galaxiesLive: boolean;
  section: NavSection;
}): ReactNode {
  // The footer is the crawl graph: navigable pages only. Dialog CTAs (submit /
  // subscribe) are surfaced in the variant headers, not as dead footer text.
  const items = renderableItems(section, galaxiesLive).filter((item) => item.kind !== "action");

  return (
    <nav aria-label={section.label} className="nav-footer-col">
      <h2 className="nav-footer-heading">{section.label}</h2>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <NavItemLink className="nav-footer-link" item={item} showIcon={false} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function NavFooter({
  galaxiesLive,
  look = "plain",
}: {
  galaxiesLive: boolean;
  look?: "colophon" | "plain";
}): ReactNode {
  return (
    <footer className={cn("nav-footer", look === "colophon" && "nav-footer--colophon")}>
      {look === "colophon" ? (
        <>
          <span aria-hidden="true" className="nav-footer-cross" />
          <span aria-hidden="true" className="nav-footer-bracket nav-footer-bracket--tl" />
          <span aria-hidden="true" className="nav-footer-bracket nav-footer-bracket--br" />
        </>
      ) : undefined}

      <div className="nav-footer-inner">
        <div className="nav-footer-brand">
          <Link aria-label="Fluncle home" className="nav-wordmark" to="/">
            FLUNCLE
          </Link>
          <p className="nav-footer-tagline">
            Drum &amp; bass bangers from another dimension, logged under a burning eclipse.
          </p>
        </div>

        <div className="nav-footer-cols">
          {navSections.map((section) => (
            <FooterColumn galaxiesLive={galaxiesLive} key={section.id} section={section} />
          ))}
        </div>
      </div>

      <div className="nav-footer-rows">
        <div className="nav-footer-followrow">
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

        <div className="nav-footer-nerdrow">
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
      </div>

      <div className="nav-footer-legal">
        <Link className="nav-footer-link" to={navDocsHome.to}>
          {navDocsHome.label}
        </Link>
        <Link className="nav-footer-link" to="/status">
          Status
        </Link>
        <Link className="nav-footer-link" to="/privacy">
          Privacy
        </Link>
        <HomeStatusPill />
      </div>
    </footer>
  );
}

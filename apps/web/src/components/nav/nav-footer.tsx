// The colophon — the site's whole navigation, banked at the bottom like a record
// sleeve's liner notes. This is the crawl backbone: any deep page is within two hops
// of every index (log ↔ artists ↔ galaxies ↔ logbook ↔ mixtapes ↔ labels-soon), which
// is where a footer earns its SEO keep. The plate grammar (crop-mark brackets +
// register cross + grain) dresses it; a darker ground than the page plate is what
// makes it read as a distinct object rather than as more page.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { HomeStatusPill } from "@/components/home/status-pill";
import { navIcon } from "@/components/nav/nav-icons";
import { NavItemLink } from "@/components/nav/nav-links";
import {
  navFollow,
  navNerds,
  navSections,
  renderableItems,
  type NavSection,
} from "@/lib/nav-model";

function FooterColumn({
  galaxiesLive,
  section,
}: {
  galaxiesLive: boolean;
  section: NavSection;
}): ReactNode {
  // Navigable pages only. The colophon is the crawl graph, so a dialog CTA (Submit a
  // track) has no place in it — it lives on the home page, where the ask belongs.
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

export function NavFooter({ galaxiesLive }: { galaxiesLive: boolean }): ReactNode {
  return (
    <footer className="nav-footer">
      <span aria-hidden="true" className="nav-footer-cross" />
      <span aria-hidden="true" className="nav-footer-bracket nav-footer-bracket--tl" />
      <span aria-hidden="true" className="nav-footer-bracket nav-footer-bracket--br" />

      <div className="nav-footer-inner">
        <div className="nav-footer-brand">
          <Link aria-label="Fluncle home" className="nav-wordmark" to="/">
            FLUNCLE
          </Link>
          <p className="nav-footer-tagline">Drum &amp; bass bangers from another dimension.</p>
        </div>

        <div className="nav-footer-cols">
          {navSections.map((section) => (
            <FooterColumn galaxiesLive={galaxiesLive} key={section.id} section={section} />
          ))}
        </div>
      </div>

      {/* Centered, label stacked over the marks — the row reads as one block rather
          than as a label with a tail. */}
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

      {/* The terminal surfaces close the plate, with the live status pill on its own
          line beneath them. No label: CLI / DIG / GIT / MCP / SSH announce themselves.
          The pill IS the link to /status, so /status never gets a second one. */}
      <div className="nav-footer-machinery">
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
        <HomeStatusPill />
      </div>
    </footer>
  );
}

// THE SECTION GRAMMAR — the one shape every band of the front door takes, and the shape later
// long-scroll surfaces reuse (DESIGN.md §5, "The Long Scroll").
//
// A section is: a heading, at most ONE line of intro, at most ONE trailing link out, then the
// content. Nothing else is allowed in the header — no kicker, no eyebrow label, no second CTA, no
// restating sub-line. That constraint is what keeps a long page reading as one deliberate scroll
// rather than a stack of landing-page panels (PRODUCT.md's anti-references, DESIGN.md's Don'ts).
//
// Rhythm is carried entirely by the documented spacing scale (`--space-*` in styles.css): sections
// are separated by `--space-band`, a section's header sits `--space-md` above its body, and the
// heading and its intro sit `--space-2xs` apart. A section never invents a gap.
//
// The heading is a real `<h2>` and the body is `aria-labelledby` it, so the page outline is
// H1 (the nameplate) → H2 per band, and a screen-reader reader can jump band to band.

import { ArrowRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

/** The one link out of a section — its own hub, named by where it goes. */
export type SectionLink = { label: string; to: string };

export function FrontDoorSection({
  children,
  id,
  intro,
  link,
  quietTitle = false,
  title,
}: {
  children: ReactNode;
  /** The heading's element id — the body's `aria-labelledby` target, and the in-page anchor. */
  id: string;
  /** One line, or none. Never two. */
  intro?: string;
  link?: SectionLink;
  /**
   * Render the heading `sr-only`. Still a real `<h2>` in the outline — a band is always jumpable —
   * but not printed, for the one band whose own control already says the heading's words out loud
   * (the search field). Never a way to drop a heading from the outline.
   */
  quietTitle?: boolean;
  title: string;
}): ReactNode {
  const headingId = `${id}-heading`;

  return (
    <section aria-labelledby={headingId} className="fd-section" id={id}>
      <header className="fd-section-head">
        <div className="fd-section-titling">
          <h2 className={quietTitle ? "sr-only" : "fd-section-title"} id={headingId}>
            {title}
          </h2>
          {intro ? <p className="fd-section-intro">{intro}</p> : undefined}
        </div>
        {link ? (
          // The nav model carries `to` as a plain string, so the cast happens at the single
          // `<Link>` boundary exactly as `NavRouteLink` does it — TanStack builds the real href
          // from the string at runtime regardless of the compile-time union.
          <Link className="fd-section-more" to={link.to as never}>
            {link.label}
            <ArrowRightIcon aria-hidden="true" className="fd-section-more-icon" />
          </Link>
        ) : undefined}
      </header>
      <div className="fd-section-body">{children}</div>
    </section>
  );
}

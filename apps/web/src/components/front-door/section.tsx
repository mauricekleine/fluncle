import { ArrowRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

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

  id: string;

  intro?: string;
  link?: SectionLink;

  quietTitle?: boolean;
  title: string;
}): ReactNode {
  const headingId = `${id}-heading`;

  const quiet = quietTitle && intro === undefined && link === undefined;

  return (
    <section aria-labelledby={headingId} className="fd-section" id={id}>
      <header className={quiet ? "fd-section-head fd-section-head--quiet" : "fd-section-head"}>
        <div className="fd-section-titling">
          <h2 className={quietTitle ? "sr-only" : "fd-section-title"} id={headingId}>
            {title}
          </h2>
          {intro ? <p className="fd-section-intro">{intro}</p> : undefined}
        </div>
        {link ? (
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

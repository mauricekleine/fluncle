import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { navSections } from "@/lib/nav-model";

const HUBS = (navSections.find((section) => section.id === "browse")?.items ?? []).flatMap(
  (item) => (item.kind === "route" && item.id !== "search" ? [item] : []),
);

export function HubFooter({ current }: { current?: string }): ReactNode {
  return (
    <footer className="log-plate-footer hub-footer">
      <nav aria-label="The archive">
        <ul className="hub-footer-list">
          {HUBS.map((hub) => (
            <li key={hub.id}>
              <Link aria-current={hub.to === current ? "page" : undefined} to={hub.to as never}>
                {hub.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  );
}

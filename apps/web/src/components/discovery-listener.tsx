import { useEffect } from "react";
import { emitDiscoveryEvent, classifyDiscoveryHref } from "@/lib/discovery-events";

function onDiscoveryClick(event: MouseEvent): void {
  try {
    if (event.button > 1) {
      return;
    }

    const pathname = window.location.pathname;

    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return;
    }

    const node = event.target;

    if (!(node instanceof Element)) {
      return;
    }

    const anchor = node.closest("a[href]");

    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }

    const href = anchor.getAttribute("href");

    if (!href) {
      return;
    }

    const similar = node.closest('[data-discovery="similar"]') !== null;
    const classified = classifyDiscoveryHref(href, {
      base: window.location.origin,
      similar,
    });

    if (!classified) {
      return;
    }

    emitDiscoveryEvent(classified.event, classified.metadata);
  } catch {}
}

export function DiscoveryListener(): null {
  useEffect(() => {
    document.documentElement.dataset.discoveryListening = "";
    document.addEventListener("click", onDiscoveryClick, { capture: true, passive: true });

    return () => {
      delete document.documentElement.dataset.discoveryListening;
      document.removeEventListener("click", onDiscoveryClick, { capture: true });
    };
  }, []);

  return null;
}

// ONE capture-phase click listener for public discovery controls that are real anchors.
//
// Search forms, palette CommandItems, and preview toggles are not anchors and emit from
// their own handlers. Everything else — GraphLinks, finding rows, Listen on Spotify, worked
// example pills, Close in sound, similar-artist chips — is classified by the resolved href
// (lib/discovery-events.ts), so a new public link of an instrumented class is covered the
// day it ships. The listener never intercepts the click, never awaits, and is passive.

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
  } catch {
    // Never surface. Navigation is the product.
  }
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

// The content script: the lens itself. It scans the page's text locally for
// `fluncle://` coordinates, turns each into a link to the finding's log page, and
// (when enabled) attaches a hover card with the finding's metadata. It keeps a live
// registry of what it found so the popup can list it and the toolbar badge can count
// it. The ONLY thing that ever leaves the browser is a per-id metadata read to
// www.fluncle.com — never page text, URLs, or DOM.

import { fetchFinding } from "./api";
import { COORDINATE_PATTERN, digCommand, safeHref, sshCommand, webUrl } from "./coordinate";
import { bangersLabel, COPY } from "./copy";
import { type LensSettings, loadSettings, onSettingsChanged } from "./settings";
import {
  type DetectedFinding,
  type FetchState,
  type FindingMeta,
  type FindingsResponse,
  type GetFindingsMessage,
} from "./types";

// Elements whose text is structural, editable, or code — never linkified.
const SKIP_TAGS = new Set([
  "BUTTON",
  "CODE",
  "INPUT",
  "KBD",
  "PRE",
  "SAMP",
  "SCRIPT",
  "SELECT",
  "STYLE",
  "TEXTAREA",
]);

// The attribute that marks a linkified coordinate, so a node is never processed
// twice (the dedupe marker). Also used to exclude the lens's own nodes from scans.
const LENS_ATTR = "data-fluncle-lens";
const HOVER_ATTR = "data-fluncle-lens-card";

// One registry per page: Log ID → the finding and its loading state. Drives the
// popup list, the badge count, and the per-id fetch dedupe.
const registry = new Map<string, DetectedFinding>();

let settings: LensSettings;

// ── Skip logic ───────────────────────────────────────────────────────────────

/** True when this element (or an ancestor) is a place we must not touch. */
function isSkippable(element: Element | null): boolean {
  let node: Element | null = element;

  while (node) {
    if (SKIP_TAGS.has(node.tagName)) {
      return true;
    }

    if (node.getAttribute("contenteditable") === "true") {
      return true;
    }

    // The lens's own injected nodes (links, hover cards).
    if (node.hasAttribute(LENS_ATTR) || node.hasAttribute(HOVER_ATTR)) {
      return true;
    }

    node = node.parentElement;
  }

  return false;
}

// ── Badge ────────────────────────────────────────────────────────────────────

function pushBadge(): void {
  chrome.runtime.sendMessage({ count: registry.size, type: "lens:badge" }).catch(() => {
    // The worker may be asleep or the tab backgrounded; the badge is best-effort.
  });
}

/**
 * Drops registry entries whose linkified node has left the DOM. SPA route changes
 * (YouTube, TikTok, …) swap out whole subtrees without a reload, so the coordinates
 * the lens linkified on the old view are gone but their ids would otherwise linger —
 * inflating the badge count and the popup list with dead entries. An id stays only
 * while at least one of its `[data-fluncle-lens="<id>"]` links is still connected.
 * Returns true when it removed anything, so the caller can repaint the badge.
 */
function pruneRegistry(): boolean {
  const dead: string[] = [];

  for (const id of registry.keys()) {
    const link = document.querySelector(`[${LENS_ATTR}="${cssEscape(id)}"]`);

    if (!link?.isConnected) {
      dead.push(id);
    }
  }

  for (const id of dead) {
    registry.delete(id);
  }

  return dead.length > 0;
}

// ── Metadata ─────────────────────────────────────────────────────────────────

/** Repaints every hover card bound to a Log ID once its metadata settles. */
function repaintCards(id: string): void {
  const finding = registry.get(id);

  if (!finding) {
    return;
  }

  for (const card of document.querySelectorAll(`[${HOVER_ATTR}="${cssEscape(id)}"]`)) {
    fillCard(card as HTMLElement, finding);
  }
}

/** Kicks off the single per-id metadata read, idempotently. */
function ensureMeta(id: string): void {
  const finding = registry.get(id);

  if (!finding || finding.state !== "loading") {
    return;
  }

  fetchFinding(id)
    .then((meta: FindingMeta | null) => {
      const state: FetchState = meta ? "ready" : "error";

      registry.set(id, { ...finding, meta: meta ?? undefined, state });
      repaintCards(id);
    })
    .catch(() => {
      registry.set(id, { ...finding, state: "error" });
      repaintCards(id);
    });
}

// ── Linkifying ───────────────────────────────────────────────────────────────

/** Records a coordinate in the registry (loading on first sight) and returns it. */
function register(id: string, raw: string): DetectedFinding {
  const existing = registry.get(id);

  if (existing) {
    return existing;
  }

  const finding: DetectedFinding = { id, raw, state: "loading" };

  registry.set(id, finding);

  return finding;
}

/** Builds the <a> that replaces a coordinate's text. */
function buildLink(id: string, raw: string): HTMLAnchorElement {
  const link = document.createElement("a");

  link.setAttribute(LENS_ATTR, id);
  link.className = "fluncle-lens-link";
  link.href = webUrl(id);
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  link.textContent = raw;
  link.title = COPY.actions.open;

  if (settings.showHoverCards) {
    attachHoverCard(link, id);
  }

  return link;
}

/**
 * Walks one text node and, if it carries coordinates, splits it into text + link
 * fragments. Returns true when it changed the DOM. Runs the regex fresh (it's
 * stateful with the `g` flag) and rebuilds the run rather than mutating in place.
 */
function linkifyTextNode(textNode: Text): boolean {
  const text = textNode.nodeValue;

  if (!text || !text.includes("fluncle://")) {
    return false;
  }

  const pattern = new RegExp(COORDINATE_PATTERN.source, "gi");
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const fragment = document.createDocumentFragment();
  let changed = false;

  while ((match = pattern.exec(text))) {
    const raw = match[0];
    const id = match[1];

    if (match.index > lastIndex) {
      fragment.append(text.slice(lastIndex, match.index));
    }

    register(id, raw);
    fragment.append(buildLink(id, raw));
    ensureMeta(id);
    lastIndex = match.index + raw.length;
    changed = true;
  }

  if (!changed) {
    return false;
  }

  if (lastIndex < text.length) {
    fragment.append(text.slice(lastIndex));
  }

  textNode.replaceWith(fragment);

  return true;
}

/** Scans a subtree's text nodes and linkifies any coordinates. */
function scan(root: Node): void {
  if (!settings.scanAllWebsites) {
    return;
  }

  const before = registry.size;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const text = node.nodeValue;

      if (!text || !text.includes("fluncle://")) {
        return NodeFilter.FILTER_REJECT;
      }

      if (isSkippable(node.parentElement)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Collect first, then mutate — mutating during the walk invalidates the walker.
  const targets: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    targets.push(node as Text);
  }

  for (const node of targets) {
    linkifyTextNode(node);
  }

  if (registry.size !== before) {
    pushBadge();
  }
}

// ── Hover card ───────────────────────────────────────────────────────────────

// Log IDs are `[0-9A-Z.]` only, but escape defensively before building an attribute
// selector. CSS.escape is standard in the extension's Chrome runtime.
function cssEscape(value: string): string {
  return CSS.escape(value);
}

/** A small labelled button that copies `value` and flashes a confirmation. */
function copyButton(label: string, value: string): HTMLButtonElement {
  const button = document.createElement("button");

  button.setAttribute(HOVER_ATTR, "");
  button.className = "fluncle-lens-action";
  button.textContent = label;
  button.type = "button";
  button.addEventListener("click", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    navigator.clipboard.writeText(value).then(
      () => {
        const original = button.textContent;

        button.textContent = COPY.copied;
        setTimeout(() => {
          button.textContent = original;
        }, 1200);
      },
      () => {
        // Clipboard denied (rare in a user-gesture context); leave the label as-is.
      },
    );
  });

  return button;
}

/** A link styled as a card action. */
function linkAction(label: string, href: string): HTMLAnchorElement {
  const action = document.createElement("a");

  action.setAttribute(HOVER_ATTR, "");
  action.className = "fluncle-lens-action";
  action.href = href;
  action.rel = "noopener noreferrer";
  action.target = "_blank";
  action.textContent = label;

  return action;
}

/** (Re)renders a hover card's body from the finding's current state. */
function fillCard(card: HTMLElement, finding: DetectedFinding): void {
  card.replaceChildren();

  const head = document.createElement("div");

  head.className = "fluncle-lens-card-head";

  const coordinate = document.createElement("span");

  coordinate.className = "fluncle-lens-coordinate";
  coordinate.textContent = finding.raw;
  head.append(coordinate);
  card.append(head);

  const body = document.createElement("div");

  body.className = "fluncle-lens-card-body";

  if (finding.state === "loading") {
    body.textContent = COPY.metaLoading;
  } else if (finding.state === "error" || !finding.meta) {
    body.textContent = COPY.metaError;
  } else {
    renderMeta(body, finding.meta);
  }

  card.append(body);
  card.append(buildActions(finding));
}

/**
 * The facts line: for a track, the release/label/tempo facts; for a mixtape, the
 * set's banger count (it has no album/tempo/key — those live on its members).
 */
function factsFor(meta: FindingMeta): string[] {
  if (meta.kind === "mixtape") {
    return typeof meta.memberCount === "number" ? [bangersLabel(meta.memberCount)] : [];
  }

  const facts: string[] = [];

  if (meta.album) {
    facts.push(meta.album);
  }

  if (meta.label) {
    facts.push(meta.label);
  }

  if (meta.year) {
    facts.push(meta.year);
  }

  if (typeof meta.bpm === "number") {
    facts.push(`${Math.round(meta.bpm)} BPM`);
  }

  if (meta.key) {
    facts.push(meta.key);
  }

  return facts;
}

/** The metadata block: artist — title, then the tabular facts. */
function renderMeta(body: HTMLElement, meta: FindingMeta): void {
  const title = document.createElement("div");

  title.className = "fluncle-lens-title";

  const artist = meta.artists?.join(", ");

  title.textContent = [artist, meta.title].filter(Boolean).join(" — ") || "Untitled finding";
  body.append(title);

  const facts = factsFor(meta);

  if (facts.length > 0) {
    const line = document.createElement("div");

    line.className = "fluncle-lens-facts";
    line.textContent = facts.join("  ·  ");
    body.append(line);
  }

  if (meta.foundAt) {
    const found = document.createElement("div");

    found.className = "fluncle-lens-found";
    found.textContent = `Found ${formatFound(meta.foundAt)}`;
    body.append(found);
  }
}

/** "2026-06-04T…" → "Jun 4, 2026"; falls back to the raw string. */
function formatFound(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

/** The card's action row. */
function buildActions(finding: DetectedFinding): HTMLElement {
  const actions = document.createElement("div");
  const target = safeHref(finding.meta?.webUrl, finding.id);

  actions.className = "fluncle-lens-actions";
  actions.append(linkAction(COPY.actions.open, target));

  if (finding.meta?.spotifyUrl) {
    actions.append(
      linkAction(COPY.actions.openSpotify, safeHref(finding.meta.spotifyUrl, finding.id)),
    );
  }

  actions.append(copyButton(COPY.actions.copyCoordinate, finding.raw));
  actions.append(copyButton(COPY.actions.copyWebUrl, target));
  actions.append(copyButton(COPY.actions.copyDig, digCommand(finding.id)));
  actions.append(copyButton(COPY.actions.copySsh, sshCommand(finding.id)));

  return actions;
}

/** Attaches a lazily-rendered hover card to a linkified coordinate. */
function attachHoverCard(link: HTMLAnchorElement, id: string): void {
  const card = document.createElement("span");

  card.setAttribute(HOVER_ATTR, id);
  card.className = "fluncle-lens-card";
  card.hidden = true;

  link.append(card);

  let painted = false;

  link.addEventListener("mouseenter", () => {
    const finding = registry.get(id);

    if (finding && !painted) {
      fillCard(card, finding);
      painted = true;
    }

    card.hidden = false;
  });

  link.addEventListener("mouseleave", () => {
    card.hidden = true;
  });
}

// ── Dynamic pages ────────────────────────────────────────────────────────────

/** Debounced rescan of nodes the page added or changed (SPA-friendly). */
function observe(): void {
  let pending: ReturnType<typeof setTimeout> | undefined;
  const queue = new Set<Node>();

  const observer = new MutationObserver((mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.ELEMENT_NODE || added.nodeType === Node.TEXT_NODE) {
          queue.add(added);
        }
      }

      if (mutation.type === "characterData" && mutation.target.parentNode) {
        queue.add(mutation.target.parentNode);
      }
    }

    if (queue.size === 0) {
      return;
    }

    clearTimeout(pending);
    pending = setTimeout(() => {
      const batch = [...queue];

      queue.clear();

      for (const node of batch) {
        if (node.isConnected) {
          scan(node);
        }
      }
    }, 250);
  });

  observer.observe(document.body, {
    characterData: true,
    childList: true,
    subtree: true,
  });
}

/**
 * Watches for SPA route changes and reconciles the registry. `history.pushState` /
 * `replaceState` don't fire any event, so they're patched to emit one; `popstate`
 * covers back/forward. On a URL change the old view's coordinates are pruned (their
 * nodes have left the DOM) and the fresh view is rescanned, keeping the badge count
 * and popup list honest across navigations without a reload.
 */
function observeNavigation(): void {
  let lastHref = location.href;

  const onNavigate = (): void => {
    if (location.href === lastHref) {
      return;
    }

    lastHref = location.href;

    // Let the SPA swap its DOM in before reconciling.
    setTimeout(() => {
      const pruned = pruneRegistry();

      if (document.body) {
        scan(document.body);
      }

      // `scan` only repaints the badge when it adds findings; a route that only
      // removed them still needs a repaint.
      if (pruned) {
        pushBadge();
      }
    }, 250);
  };

  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];

    history[method] = function patched(this: History, ...args: Parameters<History[typeof method]>) {
      const result = original.apply(this, args);

      onNavigate();

      return result;
    } as History[typeof method];
  }

  window.addEventListener("popstate", onNavigate);
}

// ── Popup channel ────────────────────────────────────────────────────────────

function answerPopup(): void {
  chrome.runtime.onMessage.addListener(
    (message: GetFindingsMessage, _sender, sendResponse: (response: FindingsResponse) => void) => {
      if (message.type === "lens:get-findings") {
        sendResponse({ findings: [...registry.values()] });
      }

      return undefined;
    },
  );
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  settings = await loadSettings();
  answerPopup();

  if (document.body) {
    scan(document.body);
    observe();
    observeNavigation();
  }

  // React to a toggle flip without a reload: a fresh scan covers turning scanning
  // on; hover-card visibility changes apply to coordinates found from then on.
  onSettingsChanged((next: LensSettings) => {
    const wasScanning = settings.scanAllWebsites;

    settings = next;

    if (next.scanAllWebsites && !wasScanning && document.body) {
      scan(document.body);
    }
  });
}

boot().catch((error: unknown) => console.error("[Fluncle Lens]", error));

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

const LENS_ATTR = "data-fluncle-lens";
const HOVER_ATTR = "data-fluncle-lens-card";

const registry = new Map<string, DetectedFinding>();

let settings: LensSettings;

function isSkippable(element: Element | null): boolean {
  let node: Element | null = element;

  while (node) {
    if (SKIP_TAGS.has(node.tagName)) {
      return true;
    }

    if (node.getAttribute("contenteditable") === "true") {
      return true;
    }

    if (node.hasAttribute(LENS_ATTR) || node.hasAttribute(HOVER_ATTR)) {
      return true;
    }

    node = node.parentElement;
  }

  return false;
}

function pushBadge(): void {
  chrome.runtime.sendMessage({ count: registry.size, type: "lens:badge" }).catch(() => {});
}

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

    for (const card of document.querySelectorAll(`[${HOVER_ATTR}="${cssEscape(id)}"]`)) {
      card.remove();
    }
  }

  return dead.length > 0;
}

function repaintCards(id: string): void {
  const finding = registry.get(id);

  if (!finding) {
    return;
  }

  for (const card of document.querySelectorAll(`[${HOVER_ATTR}="${cssEscape(id)}"]`)) {
    fillCard(card as HTMLElement, finding);
  }
}

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

function register(id: string, raw: string): DetectedFinding {
  const existing = registry.get(id);

  if (existing) {
    return existing;
  }

  const finding: DetectedFinding = { id, raw, state: "loading" };

  registry.set(id, finding);

  return finding;
}

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
    if (id === undefined) {
      continue;
    }

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

function cssEscape(value: string): string {
  return CSS.escape(value);
}

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
      () => {},
    );
  });

  return button;
}

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

function formatFound(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

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

function positionCard(link: HTMLElement, card: HTMLElement): void {
  const margin = 8;
  const gap = 6;
  const anchor = link.getBoundingClientRect();
  const { offsetWidth: cardW, offsetHeight: cardH } = card;
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;

  const roomBelow = viewportH - anchor.bottom;
  const roomAbove = anchor.top;
  const flipUp = roomBelow < cardH + gap + margin && roomAbove > roomBelow;
  let top = flipUp ? anchor.top - cardH - gap : anchor.bottom + gap;

  top = Math.max(margin, Math.min(top, viewportH - cardH - margin));

  let left = anchor.left;

  left = Math.max(margin, Math.min(left, viewportW - cardW - margin));

  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;
}

function attachHoverCard(link: HTMLAnchorElement, id: string): void {
  const card = document.createElement("span");

  card.setAttribute(HOVER_ATTR, id);
  card.className = "fluncle-lens-card";
  card.hidden = true;

  (document.body ?? document.documentElement).append(card);

  let painted = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const show = (): void => {
    clearTimeout(hideTimer);

    const finding = registry.get(id);

    if (finding && !painted) {
      fillCard(card, finding);
      painted = true;
    }

    card.hidden = false;
    positionCard(link, card);
  };

  const scheduleHide = (): void => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      card.hidden = true;
    }, 160);
  };

  link.addEventListener("mouseenter", show);
  link.addEventListener("mouseleave", scheduleHide);
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", scheduleHide);
}

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

function observeNavigation(): void {
  let lastHref = location.href;

  const onNavigate = (): void => {
    if (location.href === lastHref) {
      return;
    }

    lastHref = location.href;

    setTimeout(() => {
      const pruned = pruneRegistry();

      if (document.body) {
        scan(document.body);
      }

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

async function boot(): Promise<void> {
  settings = await loadSettings();
  answerPopup();

  if (document.body) {
    scan(document.body);
    observe();
    observeNavigation();
  }

  onSettingsChanged((next: LensSettings) => {
    const wasScanning = settings.scanAllWebsites;

    settings = next;

    if (next.scanAllWebsites && !wasScanning && document.body) {
      scan(document.body);
    }
  });
}

boot().catch((error: unknown) => console.error("[Fluncle Lens]", error));

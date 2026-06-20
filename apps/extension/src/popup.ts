// The toolbar popup: asks the active tab's content script what it found and lists
// each finding with its open/copy actions. No network of its own — the content
// script already holds the (locally detected, optionally enriched) registry.

import { digCommand, sshCommand, webUrl } from "./coordinate";
import { COPY } from "./copy";
import { type DetectedFinding, type FindingsResponse, type GetFindingsMessage } from "./types";

const countEl = document.getElementById("count") as HTMLParagraphElement;
const listEl = document.getElementById("list") as HTMLUListElement;
const optionsButton = document.getElementById("options") as HTMLButtonElement;

optionsButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

/** Copies `value` to the clipboard and flashes the button label. */
function wireCopy(button: HTMLButtonElement, value: string): void {
  const label = button.textContent;

  button.addEventListener("click", () => {
    navigator.clipboard.writeText(value).then(
      () => {
        button.textContent = COPY.copied;
        setTimeout(() => {
          button.textContent = label;
        }, 1200);
      },
      () => {},
    );
  });
}

function copyButton(label: string, value: string): HTMLButtonElement {
  const button = document.createElement("button");

  button.className = "lens-action";
  button.textContent = label;
  button.type = "button";
  wireCopy(button, value);

  return button;
}

function linkButton(label: string, href: string): HTMLAnchorElement {
  const link = document.createElement("a");

  link.className = "lens-action";
  link.href = href;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  link.textContent = label;

  return link;
}

/** The secondary line under a coordinate: artist — title, or the load state. */
function metaLine(finding: DetectedFinding): string {
  if (finding.state === "loading") {
    return COPY.metaLoading;
  }

  if (finding.state === "error" || !finding.meta) {
    return COPY.metaError;
  }

  const artist = finding.meta.artists?.join(", ");
  const line = [artist, finding.meta.title].filter(Boolean).join(" — ");

  return line || "Untitled finding";
}

function renderRow(finding: DetectedFinding): HTMLLIElement {
  const row = document.createElement("li");

  row.className = "lens-row";

  const coordinate = document.createElement("div");

  coordinate.className = "lens-row-coordinate";
  coordinate.textContent = finding.raw;
  row.append(coordinate);

  const meta = document.createElement("div");

  meta.className = finding.meta ? "lens-row-title" : "lens-row-meta";
  meta.textContent = metaLine(finding);
  row.append(meta);

  const actions = document.createElement("div");

  actions.className = "lens-actions";

  const target = finding.meta?.webUrl ?? webUrl(finding.id);

  actions.append(linkButton(COPY.actions.open, target));

  if (finding.meta?.spotifyUrl) {
    actions.append(linkButton(COPY.actions.openSpotify, finding.meta.spotifyUrl));
  }

  actions.append(copyButton(COPY.actions.copyCoordinate, finding.raw));
  actions.append(copyButton(COPY.actions.copyWebUrl, target));
  actions.append(copyButton(COPY.actions.copyDig, digCommand(finding.id)));
  actions.append(copyButton(COPY.actions.copySsh, sshCommand(finding.id)));
  row.append(actions);

  return row;
}

function render(findings: DetectedFinding[]): void {
  countEl.textContent = COPY.countHeading(findings.length);
  listEl.replaceChildren();

  if (findings.length === 0) {
    const empty = document.createElement("li");

    empty.className = "lens-empty";
    empty.textContent = COPY.emptyState;
    listEl.append(empty);

    return;
  }

  for (const finding of findings) {
    listEl.append(renderRow(finding));
  }
}

async function load(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    render([]);

    return;
  }

  try {
    const message: GetFindingsMessage = { type: "lens:get-findings" };
    const response = (await chrome.tabs.sendMessage(tab.id, message)) as
      | FindingsResponse
      | undefined;

    render(response?.findings ?? []);
  } catch {
    // No content script on this page (e.g. chrome:// or the web store) — quiet sector.
    render([]);
  }
}

load().catch((error: unknown) => console.error("[Fluncle Lens]", error));

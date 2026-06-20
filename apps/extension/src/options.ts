// The options page: three toggles persisted to chrome.storage.sync. The content
// script reacts live (onSettingsChanged), so nothing here needs a reload.

import { COPY } from "./copy";
import { loadSettings, saveSettings } from "./settings";

const scan = document.getElementById("scan") as HTMLInputElement;
const cards = document.getElementById("cards") as HTMLInputElement;
const target = document.getElementById("target") as HTMLSelectElement;

const scanHint = document.getElementById("scan-hint") as HTMLDivElement;
const cardsHint = document.getElementById("cards-hint") as HTMLDivElement;
const targetHint = document.getElementById("target-hint") as HTMLDivElement;
const scanLabel = document.getElementById("scan-label") as HTMLDivElement;
const cardsLabel = document.getElementById("cards-label") as HTMLDivElement;
const targetLabel = document.getElementById("target-label") as HTMLDivElement;

// Hydrate the copy from the single source so the strings stay reviewable in copy.ts.
scanLabel.textContent = COPY.options.scanLabel;
cardsLabel.textContent = COPY.options.showCardsLabel;
targetLabel.textContent = COPY.options.linkTargetLabel;
scanHint.textContent = COPY.options.scanHint;
cardsHint.textContent = COPY.options.showCardsHint;
targetHint.textContent = COPY.options.linkTargetHint;

async function init(): Promise<void> {
  const settings = await loadSettings();

  scan.checked = settings.scanAllWebsites;
  cards.checked = settings.showHoverCards;
  target.value = settings.linkTarget;

  scan.addEventListener("change", () => {
    saveSettings({ scanAllWebsites: scan.checked }).catch(() => {});
  });

  cards.addEventListener("change", () => {
    saveSettings({ showHoverCards: cards.checked }).catch(() => {});
  });

  target.addEventListener("change", () => {
    saveSettings({ linkTarget: "web" }).catch(() => {});
  });
}

init().catch((error: unknown) => console.error("[Fluncle Lens]", error));

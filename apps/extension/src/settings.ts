// Fluncle Lens settings, persisted in `chrome.storage.sync` so they ride along with
// the user's Chrome profile. Three toggles, matching the brief's options screen.
// The content script reads these to decide whether to scan and whether to attach
// hover cards; the options page writes them.

/** The future link-target options aren't built for MVP — only the web target ships. */
export type LinkTarget = "web";

export type LensSettings = {
  linkTarget: LinkTarget;
  scanAllWebsites: boolean;
  showHoverCards: boolean;
};

export const DEFAULT_SETTINGS: LensSettings = {
  linkTarget: "web",
  scanAllWebsites: true,
  showHoverCards: true,
};

const STORAGE_KEY = "lensSettings";

/** Reads settings, falling back to defaults for any missing key. */
export async function loadSettings(): Promise<LensSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<LensSettings> | undefined;

  return { ...DEFAULT_SETTINGS, ...value };
}

/** Persists a partial settings change, merged over what's stored. */
export async function saveSettings(patch: Partial<LensSettings>): Promise<void> {
  const current = await loadSettings();

  await chrome.storage.sync.set({ [STORAGE_KEY]: { ...current, ...patch } });
}

/** Subscribes to settings changes (e.g. the content script reacting to a toggle). */
export function onSettingsChanged(handler: (settings: LensSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE_KEY]) {
      handler({ ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue as Partial<LensSettings>) });
    }
  });
}

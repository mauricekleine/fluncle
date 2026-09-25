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

export async function loadSettings(): Promise<LensSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<LensSettings> | undefined;

  return { ...DEFAULT_SETTINGS, ...value };
}

export async function saveSettings(patch: Partial<LensSettings>): Promise<void> {
  const current = await loadSettings();

  await chrome.storage.sync.set({ [STORAGE_KEY]: { ...current, ...patch } });
}

export function onSettingsChanged(handler: (settings: LensSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE_KEY]) {
      handler({ ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue as Partial<LensSettings>) });
    }
  });
}

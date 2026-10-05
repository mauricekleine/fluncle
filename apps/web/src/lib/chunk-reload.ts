const CHUNK_RELOAD_KEY = "fluncle-chunk-reload";
const CHUNK_RELOAD_WINDOW_MS = 60_000;

type ChunkReloadDependencies = {
  location: Pick<Location, "href" | "reload">;
  now: () => number;
  storage: Pick<Storage, "getItem" | "setItem">;
};

export function createChunkReloadGuard(deps: ChunkReloadDependencies) {
  let reloading = false;

  return {
    handlePreloadError: (event: Event): void => {
      let stored: string | null;

      try {
        stored = deps.storage.getItem(CHUNK_RELOAD_KEY);
      } catch {
        return;
      }

      let record: unknown;

      try {
        record = stored === null ? null : JSON.parse(stored);
      } catch {
        record = null;
      }

      const href = deps.location.href;
      const at = deps.now();

      if (
        typeof record === "object" &&
        record !== null &&
        "href" in record &&
        record.href === href &&
        "at" in record &&
        typeof record.at === "number" &&
        Number.isFinite(record.at) &&
        at - record.at < CHUNK_RELOAD_WINDOW_MS
      ) {
        return;
      }

      try {
        deps.storage.setItem(CHUNK_RELOAD_KEY, JSON.stringify({ at, href }));
      } catch {
        return;
      }

      reloading = true;
      event.preventDefault();
      deps.location.reload();
    },
    isReloading: (): boolean => reloading,
  };
}

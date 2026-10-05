import { MIN_QUERY_LENGTH } from "./search-results";

export const PALETTE_SEARCH_IDLE_MS = 2000;

export function createPaletteSearchCommit(onCommit: (query: string) => void) {
  const committed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancelIdle(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function commit(query: string, example: boolean): void {
    cancelIdle();
    const settled = query.trim();

    if (example || settled.length < MIN_QUERY_LENGTH || committed.has(settled)) {
      return;
    }

    committed.add(settled);
    onCommit(settled);
  }

  function settle(query: string, example: boolean): void {
    cancelIdle();
    timer = setTimeout(() => commit(query, example), PALETTE_SEARCH_IDLE_MS);
  }

  function reset(): void {
    cancelIdle();
    committed.clear();
  }

  return { cancelIdle, commit, reset, settle };
}

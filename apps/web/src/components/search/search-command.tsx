import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
const loadSearchDialog = () => import("@/components/search/search-dialog");
const SearchDialog = lazy(async () => ({ default: (await loadSearchDialog()).SearchDialog }));

export function prefetchSearchDialog(): void {
  void loadSearchDialog();
}

export type SearchController = {
  open: (query?: string) => void;

  seed?: { query: string; token: number };

  setOpen: (open: boolean) => void;

  state: boolean;
};

const SearchContext = createContext<SearchController | undefined>(undefined);

export function SearchProvider({ children }: { children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<{ query: string; token: number }>();

  const controller = useMemo<SearchController>(
    () => ({
      open: (query?: string) => {
        if (query !== undefined) {
          setSeed((current) => ({ query, token: (current?.token ?? 0) + 1 }));
        }

        setOpen(true);
      },
      seed,
      setOpen,
      state: open,
    }),
    [open, seed],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return <SearchContext.Provider value={controller}>{children}</SearchContext.Provider>;
}

export function useSearchController(): SearchController {
  const controller = useContext(SearchContext);

  return controller ?? NO_SEARCH;
}

const NO_SEARCH: SearchController = { open: () => {}, setOpen: () => {}, state: false };

export function SearchTrigger({ showTrigger = true }: { showTrigger?: boolean }): ReactNode {
  const { open, seed, setOpen, state } = useSearchController();
  const isApple = useIsApple();
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    if (state) {
      setActivated(true);
    }
  }, [state]);

  return (
    <>
      {showTrigger ? (
        <button
          aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}
          aria-label="Search the archive"
          className="search-trigger"
          onClick={() => open()}
          onFocus={prefetchSearchDialog}
          onPointerEnter={prefetchSearchDialog}
          type="button"
        >
          <MagnifyingGlassIcon aria-hidden="true" className="search-trigger-icon" />
          <span className="search-trigger-label">Search</span>

          <kbd aria-hidden="true" className="search-trigger-kbd">
            {isApple ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      ) : undefined}

      {state || activated ? (
        <Suspense fallback={null}>
          <SearchDialog onOpenChange={setOpen} open={state} seed={seed} />
        </Suspense>
      ) : undefined}
    </>
  );
}

export function useIsApple(): boolean {
  const [isApple, setIsApple] = useState(false);

  useEffect(() => {
    setIsApple(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent));
  }, []);

  return isApple;
}

import { CaretDownIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, type RefObject, Suspense, useEffect, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuTrigger } from "@fluncle/ui/components/dropdown-menu";
import { Sheet, SheetTrigger } from "@fluncle/ui/components/sheet";
import { LazyPopupBoundary } from "@/components/lazy-popup-boundary";
import { lazyNamed } from "@/lib/lazy-named";

const loadBrowsePopup = () => import("@/components/nav/browse-popup");
const BrowseDropdownContent = lazyNamed(loadBrowsePopup, "BrowseDropdownContent");
const BrowseSheetContent = lazyNamed(loadBrowsePopup, "BrowseSheetContent");

export type BrowseShortcut = {
  label: string;
  search?: Record<string, string>;
  to: string;
};

export type BrowseShortcuts = {
  items: BrowseShortcut[];
  label: string;
};

type Presentation = "menu" | "sheet";

type PresentationProps = {
  current: string;
  open: boolean;
  returnFocus: () => boolean;
  setOpen: (open: boolean) => void;
  shortcuts?: BrowseShortcuts;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

export function isSearchShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey">) {
  return event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
}

function prefetchBrowsePopup(): void {
  void loadBrowsePopup();
}

function TriggerFace(): ReactNode {
  return (
    <>
      <SquaresFourIcon aria-hidden="true" className="browse-trigger-icon" weight="bold" />
      <span className="browse-trigger-label">Browse</span>
      <CaretDownIcon aria-hidden="true" className="browse-trigger-caret" weight="bold" />
    </>
  );
}

function BrowseDropdown({
  current,
  open,
  returnFocus,
  setOpen,
  shortcuts,
  triggerRef,
}: PresentationProps): ReactNode {
  const [activated, setActivated] = useState(false);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setActivated(true);
    }

    setOpen(next);
  };

  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        aria-label="Browse the archive"
        className="browse-trigger browse-trigger--menu"
        onFocus={prefetchBrowsePopup}
        onPointerDown={prefetchBrowsePopup}
        onPointerEnter={prefetchBrowsePopup}
        ref={triggerRef}
      >
        <TriggerFace />
      </DropdownMenuTrigger>
      {open || activated ? (
        <LazyPopupBoundary>
          <Suspense fallback={null}>
            <BrowseDropdownContent
              current={current}
              returnFocus={returnFocus}
              shortcuts={shortcuts}
            />
          </Suspense>
        </LazyPopupBoundary>
      ) : null}
    </DropdownMenu>
  );
}

function BrowseSheet({
  current,
  open,
  returnFocus,
  setOpen,
  shortcuts,
  triggerRef,
}: PresentationProps): ReactNode {
  const [activated, setActivated] = useState(false);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setActivated(true);
    }

    setOpen(next);
  };

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetTrigger
        aria-label="Browse the archive"
        className="browse-trigger browse-trigger--sheet"
        onFocus={prefetchBrowsePopup}
        onPointerDown={prefetchBrowsePopup}
        onPointerEnter={prefetchBrowsePopup}
        ref={triggerRef}
      >
        <TriggerFace />
      </SheetTrigger>
      {open || activated ? (
        <LazyPopupBoundary>
          <Suspense fallback={null}>
            <BrowseSheetContent
              current={current}
              returnFocus={returnFocus}
              setOpen={setOpen}
              shortcuts={shortcuts}
            />
          </Suspense>
        </LazyPopupBoundary>
      ) : null}
    </Sheet>
  );
}

export function BrowseMenu({ shortcuts }: { shortcuts?: BrowseShortcuts }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [open, setOpen] = useState<Presentation | undefined>(undefined);
  const yieldingToSearch = useRef(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const sheetTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open === undefined) {
      return;
    }

    const presentation = open;

    function onKeyDown(event: KeyboardEvent): void {
      if (!isSearchShortcut(event)) {
        return;
      }

      yieldingToSearch.current = true;
      setOpen(undefined);
      (presentation === "menu" ? menuTrigger : sheetTrigger).current?.focus();
    }

    document.addEventListener("keydown", onKeyDown, { capture: true });

    return () => document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open]);

  const returnFocus = () => {
    if (yieldingToSearch.current) {
      yieldingToSearch.current = false;

      return false;
    }

    return true;
  };

  const shared = { current: pathname, returnFocus, shortcuts };

  return (
    <>
      <BrowseDropdown
        {...shared}
        open={open === "menu"}
        setOpen={(next) => setOpen(next ? "menu" : undefined)}
        triggerRef={menuTrigger}
      />
      <BrowseSheet
        {...shared}
        open={open === "sheet"}
        setOpen={(next) => setOpen(next ? "sheet" : undefined)}
        triggerRef={sheetTrigger}
      />
    </>
  );
}

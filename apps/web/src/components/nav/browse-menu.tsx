import { CaretDownIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { Button } from "@fluncle/ui/components/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@fluncle/ui/components/sheet";
import { navBrowseHubs } from "@/lib/nav-model";

export type BrowseShortcut = {
  label: string;
  search?: Record<string, string>;
  to: string;
};

export type BrowseShortcuts = {
  items: BrowseShortcut[];
  label: string;
};

type Hub = { blurb?: string; id: string; label: string; to: string };

type Presentation = "menu" | "sheet";

const HUBS: Hub[] = navBrowseHubs.flatMap((item) =>
  item.kind === "route" ? [{ blurb: item.blurb, id: item.id, label: item.label, to: item.to }] : [],
);

export function isSearchShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey">) {
  return event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
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

function HubText({ hub }: { hub: Hub }): ReactNode {
  return (
    <span className="browse-hub-text">
      <span className="browse-hub-label">{hub.label}</span>
      {hub.blurb ? <span className="browse-hub-blurb">{hub.blurb}</span> : null}
    </span>
  );
}

type PresentationProps = {
  current: string;
  open: boolean;
  returnFocus: () => boolean;
  setOpen: (open: boolean) => void;
  shortcuts?: BrowseShortcuts;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

function BrowseDropdown({
  current,
  open,
  returnFocus,
  setOpen,
  shortcuts,
  triggerRef,
}: PresentationProps): ReactNode {
  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        aria-label="Browse the archive"
        className="browse-trigger browse-trigger--menu"
        ref={triggerRef}
      >
        <TriggerFace />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="browse-menu w-72 shadow-none"
        finalFocus={returnFocus}
      >
        <DropdownMenuGroup>
          {HUBS.map((hub) => {
            const active = hub.to === current;

            return (
              <DropdownMenuItem
                className={active ? "browse-hub browse-hub--active" : "browse-hub"}
                key={hub.id}
                render={<Link aria-current={active ? "page" : undefined} to={hub.to as never} />}
              >
                <HubText hub={hub} />
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {shortcuts && shortcuts.items.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup className="browse-shortcuts">
              <DropdownMenuLabel>{shortcuts.label}</DropdownMenuLabel>
              <div className="browse-shortcut-row">
                {shortcuts.items.map((shortcut) => (
                  <DropdownMenuItem
                    className="browse-shortcut"
                    key={`${shortcut.to}:${JSON.stringify(shortcut.search ?? {})}`}
                    render={<Link search={shortcut.search as never} to={shortcut.to as never} />}
                  >
                    {shortcut.label}
                  </DropdownMenuItem>
                ))}
              </div>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
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
  const close = () => setOpen(false);

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger
        aria-label="Browse the archive"
        className="browse-trigger browse-trigger--sheet"
        ref={triggerRef}
      >
        <TriggerFace />
      </SheetTrigger>
      <SheetContent
        className="browse-sheet gap-0 shadow-none ring-1 ring-foreground/10 motion-reduce:transition-none motion-reduce:duration-0"
        finalFocus={returnFocus}
        showCloseButton={false}
        side="bottom"
      >
        <SheetHeader className="flex-row items-center justify-between border-b border-border">
          <SheetTitle>Browse</SheetTitle>
          <SheetClose render={<Button className="size-11" size="icon" variant="ghost" />}>
            <XIcon aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetClose>
        </SheetHeader>
        <nav aria-label="Browse the archive" className="browse-sheet-body">
          <ul className="browse-sheet-list">
            {HUBS.map((hub) => {
              const active = hub.to === current;

              return (
                <li key={hub.id}>
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={active ? "browse-hub browse-hub--active" : "browse-hub"}
                    onClick={close}
                    to={hub.to as never}
                  >
                    <HubText hub={hub} />
                  </Link>
                </li>
              );
            })}
          </ul>
          {shortcuts && shortcuts.items.length > 0 ? (
            <div className="browse-shortcuts browse-shortcuts--sheet">
              <p className="browse-shortcuts-label">{shortcuts.label}</p>
              <ul className="browse-shortcut-row">
                {shortcuts.items.map((shortcut) => (
                  <li key={`${shortcut.to}:${JSON.stringify(shortcut.search ?? {})}`}>
                    <Link
                      className="browse-shortcut"
                      onClick={close}
                      search={shortcut.search as never}
                      to={shortcut.to as never}
                    >
                      {shortcut.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </nav>
      </SheetContent>
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

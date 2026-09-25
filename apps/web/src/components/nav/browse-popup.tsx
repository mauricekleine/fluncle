import { XIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@fluncle/ui/components/dropdown-menu";
import { SheetClose, SheetContent, SheetHeader, SheetTitle } from "@fluncle/ui/components/sheet";
import { navBrowseHubs } from "@/lib/nav-model";
import { type BrowseShortcuts } from "@/components/nav/browse-menu";

type Hub = { blurb?: string; id: string; label: string; to: string };

type PopupProps = {
  current: string;
  returnFocus: () => boolean;
  shortcuts?: BrowseShortcuts;
};

const HUBS: Hub[] = navBrowseHubs.flatMap((item) =>
  item.kind === "route" ? [{ blurb: item.blurb, id: item.id, label: item.label, to: item.to }] : [],
);

function HubText({ hub }: { hub: Hub }): ReactNode {
  return (
    <span className="browse-hub-text">
      <span className="browse-hub-label">{hub.label}</span>
      {hub.blurb ? <span className="browse-hub-blurb">{hub.blurb}</span> : null}
    </span>
  );
}

export function BrowseDropdownContent({ current, returnFocus, shortcuts }: PopupProps): ReactNode {
  return (
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
  );
}

export function BrowseSheetContent({
  current,
  returnFocus,
  shortcuts,
  setOpen,
}: PopupProps & {
  setOpen: (open: boolean) => void;
}): ReactNode {
  const close = () => setOpen(false);

  return (
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
  );
}

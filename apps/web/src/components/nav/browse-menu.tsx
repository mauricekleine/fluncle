// THE BROWSE MENU — the one top-bar route between the catalogue hubs (DESIGN.md "Browse Menu").
//
// The colophon still carries the whole nav (the crawl backbone); this control exists because a
// reader deep on a label page should not have to scroll to the liner notes to get to Artists. It is
// ARCHIVE ONLY: the five hubs (Tracks, Artists, Albums, Labels, Fresh), read from the nav model so a
// hub's label and blurb are the colophon's own. The lore pages stay in the colophon and on the front
// door.
//
// ONE control, two presentations, chosen by CSS rather than by JS so the server and the client
// render the same markup: from 40rem up a Shadcn dropdown anchored under the trigger; below it a
// bottom sheet with thumb-sized rows. Both triggers render, and the one that does not fit the
// viewport is `display: none`, which also takes it out of the accessibility tree. The dropdown is
// Base UI's menu (arrow keys, Enter, Escape, focus back to the trigger); the sheet is a modal dialog
// (focus trap, Escape, focus back).
//
// The current hub is marked the way the account menu marks its current door: `aria-current` for
// assistive tech and a quiet cream tint for sight, never gold (a door is not a certification).
//
// THE SHORTCUT SEAM. `shortcuts` is an optional second group under the hubs, rendered as a wrapping
// row of chips in both presentations. The style-chip row (the style lexicon's shortcuts into
// `/tracks?sound=`) plugs in here from `PublicChrome`; with nothing passed, nothing renders.

import { CaretDownIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
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

/** One shortcut chip: a literal label and the in-app route (plus search params) it opens. */
export type BrowseShortcut = {
  label: string;
  search?: Record<string, string>;
  to: string;
};

/** The optional shortcut group under the hubs: its heading and its chips. */
export type BrowseShortcuts = {
  items: BrowseShortcut[];
  label: string;
};

type Hub = { blurb?: string; id: string; label: string; to: string };

const HUBS: Hub[] = navBrowseHubs.flatMap((item) =>
  item.kind === "route" ? [{ blurb: item.blurb, id: item.id, label: item.label, to: item.to }] : [],
);

/** The trigger's face, shared by both presentations so they read as one control. */
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

/** The dropdown presentation (40rem and up). */
function BrowseDropdown({
  current,
  shortcuts,
}: {
  current: string;
  shortcuts?: BrowseShortcuts;
}): ReactNode {
  return (
    <DropdownMenu>
      {/* The accessible name contains the visible word ("Browse"), so a voice-control user saying
          what they see reaches it (WCAG 2.5.3, the search trigger's rule). */}
      <DropdownMenuTrigger
        aria-label="Browse the archive"
        className="browse-trigger browse-trigger--menu"
      >
        <TriggerFace />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="browse-menu w-72 shadow-none">
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
            {/* Base UI requires a GroupLabel to live inside a Group (the account menu's note). */}
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

/** The sheet presentation (below 40rem): the same list, with rows sized for a thumb. */
function BrowseSheet({
  current,
  shortcuts,
}: {
  current: string;
  shortcuts?: BrowseShortcuts;
}): ReactNode {
  // The chrome persists across navigation, so the sheet closes itself when a row is taken rather
  // than staying open over the page it just opened.
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger
        aria-label="Browse the archive"
        className="browse-trigger browse-trigger--sheet"
      >
        <TriggerFace />
      </SheetTrigger>
      {/* The plate's glass instead of an opaque popover, no drop shadow (Through-the-Glass), and a
          slide that stands still under reduced motion: the behind-the-scenes sheet's recipe. */}
      <SheetContent
        className="browse-sheet gap-0 shadow-none ring-1 ring-foreground/10 motion-reduce:transition-none motion-reduce:duration-0"
        showCloseButton={false}
        side="bottom"
      >
        {/* The close control is drawn here rather than by the generated sheet so it is thumb-sized
            like every row under it. */}
        <SheetHeader className="flex-row items-center justify-between border-b border-border">
          <SheetTitle>Browse</SheetTitle>
          <SheetClose render={<Button className="size-11" size="icon" variant="ghost" />}>
            <XIcon aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetClose>
        </SheetHeader>
        <nav aria-label="Browse the archive">
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

/**
 * The Browse control for the top bar. Mounted once by `PublicChrome` on every public page, the
 * front door included. `shortcuts` is the seam for the style-chip row.
 */
export function BrowseMenu({ shortcuts }: { shortcuts?: BrowseShortcuts }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <>
      <BrowseDropdown current={pathname} shortcuts={shortcuts} />
      <BrowseSheet current={pathname} shortcuts={shortcuts} />
    </>
  );
}

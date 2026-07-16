// THE CREW SLOT — the top-right identity control, beside search in the colophon bar.
//
// One element, two faces, resolved from the session:
//   - SIGNED OUT (and while the session is still resolving): the "Join the crew"
//     button that used to live in the home masthead — the identity CTA, now
//     reachable from every public page, not just home. Rendering it during the
//     pending state means the bar never shifts: the join button and the account
//     door share a footprint, so the swap is a content change, not a reflow.
//     ON HOME it keeps its moving glow (.crew-glow) — the flourish it always wore
//     there. EVERYWHERE ELSE it stays a quiet outline: the ambient budget is
//     exactly two movements (DESIGN.md §5), and a perpetual gold sweep riding
//     every /log page would out-shout the page's own gold (Listen, the
//     coordinate, FOUND — One Sun).
//   - SIGNED IN: a quiet door — a glyph, the name, and a caret — opening a small
//     account menu (the account tabs + sign out). It heats like search does (the
//     Gold Veil on hover), and it is a real Shadcn dropdown, so it is fully
//     keyboard-operable for free (arrow keys, Enter, Escape, focus return).
//
// The menu is built to GROW. ChatDnB and Recommendations are both LIVE now (their
// own doors at /chat and /recommendations). A future door lands the same way: add
// its entry, and for one not yet routable keep it flagged `future` so it is filtered
// OUT of the render until its route exists — the day it lands, delete the flag and
// the door lights up. Same discipline as the nav model's `future` slot (lib/nav-model.ts).

import {
  BinocularsIcon,
  BookmarkSimpleIcon,
  CaretDownIcon,
  ChatCircleDotsIcon,
  GearSixIcon,
  PlanetIcon,
  SignOutIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { authClient } from "@/lib/auth-client";

/** The signed-in account tab a menu link opens (absent = the default Galaxy view). */
type AccountTab = "saves" | "settings";

/**
 * One row in the account menu. Two shapes:
 * - LIVE: a door into `/account` (optionally onto one of its tabs), or — when `to`
 *   is set — onto its own top-level route (`/chat`, `/recommendations`). `to` is a
 *   TYPED literal union, so every live door keeps its compile-time route check.
 * - FUTURE: a designed-but-unshipped door. Its `to` is a plain provisional string
 *   (the route does not exist in the type graph yet), it is flagged, and it is
 *   FILTERED OUT of the render — no dead link ever ships. Delete the flag (and set
 *   the real path) the day the route lands.
 */
type CrewMenuLink =
  | {
      future?: undefined;
      icon: ReactNode;
      id: string;
      label: string;
      search?: { tab: AccountTab };
      to?: "/chat" | "/recommendations";
    }
  | { future: true; icon: ReactNode; id: string; label: string; to: string };

const CREW_MENU_LINKS: CrewMenuLink[] = [
  // "Galaxy", not "My account" — the door's name matches the room (the default
  // /account view is the game record), so the menu reads as honest siblings:
  // Galaxy / Saves / Settings. Revisit the default door once the rec engine lands.
  { icon: <PlanetIcon aria-hidden="true" />, id: "galaxy", label: "Galaxy" },
  {
    icon: <BookmarkSimpleIcon aria-hidden="true" />,
    id: "saves",
    label: "Saves",
    search: { tab: "saves" },
  },
  {
    icon: <GearSixIcon aria-hidden="true" />,
    id: "settings",
    label: "Settings",
    search: { tab: "settings" },
  },
  // ChatDnB — LIVE (the verified-user rollout). The menu shows the door to every
  // signed-in user; the /chat page itself communicates the verify gate — a menu item
  // may lead to a door that asks for verification, that is honest wayfinding.
  {
    icon: <ChatCircleDotsIcon aria-hidden="true" />,
    id: "chatdnb",
    label: "ChatDnB",
    to: "/chat",
  },
  // Recommendations — LIVE (the per-listener telescope). Same wayfinding: the menu
  // shows the door to every signed-in user; the /recommendations page itself carries
  // the verify gate.
  {
    icon: <BinocularsIcon aria-hidden="true" />,
    id: "recommendations",
    label: "Recommendations",
    to: "/recommendations",
  },
  // ── EXTENSION SLOT ──────────────────────────────────────────────────────────
  // A future door lands here flagged `future` (filtered OUT of the render so no dead
  // link ships) until its route exists; delete the flag the day it lands.
];

/** The rows that actually render: the live doors, never a future one. */
const liveMenuLinks = CREW_MENU_LINKS.filter(
  (link): link is Extract<CrewMenuLink, { future?: undefined }> => !link.future,
);

/**
 * The signed-out CTA — the masthead's "Join the crew" button, relocated. An OUTLINE
 * control (never a gold FILL — One Sun). On home it wears the moving glow it always
 * wore there; on every other page it stays quiet, because the ambient budget is
 * exactly two movements and a page's own gold must keep leading. The label collapses
 * to the glyph on a narrow bar, exactly as the search label does, so the top bar
 * stays one line; the accessible name rides on the Link either way.
 */
function JoinButton({ glow }: { glow: boolean }): ReactNode {
  return (
    <Button
      className={glow ? "crew-glow" : undefined}
      nativeButton={false}
      render={<Link aria-label="Join the crew" to="/account" />}
      size="sm"
      variant="outline"
    >
      <UsersThreeIcon aria-hidden="true" weight="bold" />
      <span className="crew-slot-label">Join the crew</span>
    </Button>
  );
}

/**
 * The signed-in door. A quiet trigger (glyph + name + caret) opening the account
 * menu. `signOut` clears the session then reloads: better-auth drops the session
 * atom (so this trigger swaps back to Join on its own), and the reload also refreshes
 * any signed-in surface reading `/api/me` (the account page), so no stale signed-in
 * view survives the sign-out anywhere.
 */
function AccountMenu({ image, name }: { image: null | string; name: string }): ReactNode {
  async function signOut() {
    await authClient.signOut();
    // A full reload is the cleanest way to flush EVERY signed-in surface at once —
    // this trigger reacts to the session atom on its own, but the account page reads
    // `/api/me` in an effect, so only a reload guarantees it re-reads signed-out.
    globalThis.location.reload();
  }

  // The active-door marker (the account redesign brief §Wayfinding): the menu link
  // matching the current view is marked (`aria-current` for assistive tech, a quiet
  // cream tint for sight). ChatDnB and Recommendations are their own routes; on
  // `/account` the tab decides, and a bare `/account` is the Galaxy.
  const location = useRouterState({ select: (state) => state.location });
  const tab = (location.search as { tab?: string }).tab;
  const activeDoor: null | "chatdnb" | "galaxy" | "recommendations" | "saves" | "settings" =
    location.pathname === "/chat"
      ? "chatdnb"
      : location.pathname === "/recommendations"
        ? "recommendations"
        : location.pathname === "/account"
          ? tab === "saves" || tab === "settings"
            ? tab
            : "galaxy"
          : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Your account" className="crew-trigger">
        {image ? (
          // The account's avatar (Google fills it at sign-up; an upload path is a
          // future slice). Decorative — the name sits beside it.
          <img alt="" className="crew-trigger-avatar" src={image} />
        ) : (
          <UserCircleIcon aria-hidden="true" className="crew-trigger-icon" weight="bold" />
        )}
        <span className="crew-slot-label">{name}</span>
        <CaretDownIcon aria-hidden="true" className="crew-trigger-caret" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {/* Base UI requires a GroupLabel to live inside a Group — a bare
            DropdownMenuLabel throws MenuGroupContext at runtime (browser-verified). */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Signed in as {name}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {liveMenuLinks.map((link) => {
          const active = link.id === activeDoor;

          return (
            <DropdownMenuItem
              className={active ? "crew-menu-item-active" : undefined}
              key={link.id}
              render={
                link.to ? (
                  <Link aria-current={active ? "page" : undefined} to={link.to} />
                ) : link.search ? (
                  <Link
                    aria-current={active ? "page" : undefined}
                    search={link.search}
                    to="/account"
                  />
                ) : (
                  <Link aria-current={active ? "page" : undefined} to="/account" />
                )
              }
            >
              {link.icon}
              {link.label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>
          <SignOutIcon aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The one control mounted in the top bar (PublicChrome), just after search. Resolves
 * the session client-side and shows Join until a signed-in session is CONFIRMED, then
 * the account door. The two share a footprint, so the resolve never shifts the bar.
 * `home` gates the Join glow to the one page it was designed for.
 */
export function CrewSlot({ home }: { home: boolean }): ReactNode {
  const { data: session } = authClient.useSession();
  const user = session?.user;

  if (!user) {
    return <JoinButton glow={home} />;
  }

  // Name first (the X model, operator-ratified 2026-07-16): the header shows the
  // freeform Name; the handle is the fallback for a name-less account.
  const name = user.name || (user.displayUsername ?? user.username ?? "cosmonaut");

  return <AccountMenu image={user.image ?? null} name={name} />;
}

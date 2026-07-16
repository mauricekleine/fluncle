// THE CREW SLOT — the top-right identity control, beside search in the colophon bar.
//
// One element, two faces, resolved from the session:
//   - SIGNED OUT (and while the session is still resolving): the "Join the crew"
//     button that used to live in the home masthead. It keeps its moving glow
//     (.crew-glow) — the identity CTA, now reachable from every public page, not
//     just home. Rendering it during the pending state means the bar never shifts:
//     the join button and the account door share a footprint, so the swap is a
//     content change, not a reflow.
//   - SIGNED IN: a quiet door — a glyph, the name, and a caret — opening a small
//     account menu (the account tabs + sign out). It heats like search does (the
//     Gold Veil on hover), and it is a real Shadcn dropdown, so it is fully
//     keyboard-operable for free (arrow keys, Enter, Escape, focus return).
//
// The menu is built to GROW. Two more doors are coming — ChatDnB and the
// per-listener recommendation engine — and they live below as FUTURE slots:
// present in the model, flagged, and filtered OUT of the render so no dead link
// ever ships. The day their route lands, delete the one `future` flag and the door
// lights up. Same discipline as the nav model's `future` slot (lib/nav-model.ts).

import {
  BookmarkSimpleIcon,
  CaretDownIcon,
  GearSixIcon,
  SignOutIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { Button } from "@fluncle/ui/components/button";
import { authClient } from "@/lib/auth-client";

/** The signed-in account tab a menu link opens (absent = the default Galaxy view). */
type AccountTab = "saves" | "settings";

/**
 * One row in the account menu. `to` is a plain string (the data-driven navigate
 * boundary casts it), so a not-yet-shipped `future` slot can name a route that does
 * not exist in the type graph yet without a compile error. A `future` row is never
 * rendered — no dead links — but it keeps the slot concrete and greppable.
 */
type CrewMenuLink = {
  future?: true;
  icon: ReactNode;
  id: string;
  label: string;
  search?: { tab: AccountTab };
  to: string;
};

const CREW_MENU_LINKS: CrewMenuLink[] = [
  {
    icon: <UserCircleIcon aria-hidden="true" />,
    id: "account",
    label: "My account",
    to: "/account",
  },
  {
    icon: <BookmarkSimpleIcon aria-hidden="true" />,
    id: "saves",
    label: "Saves",
    search: { tab: "saves" },
    to: "/account",
  },
  {
    icon: <GearSixIcon aria-hidden="true" />,
    id: "settings",
    label: "Settings",
    search: { tab: "settings" },
    to: "/account",
  },
  // ── EXTENSION SLOTS ─────────────────────────────────────────────────────────
  // Two more doors are planned. They are FILTERED OUT while `future` is set (so no
  // dead link ships); remove the flag the day the route exists to light one up. The
  // `to` values are provisional placeholders — set the real path when it lands.
  {
    future: true,
    icon: <UserCircleIcon aria-hidden="true" />,
    id: "chatdnb",
    label: "ChatDnB",
    to: "/chat",
  },
  {
    future: true,
    icon: <UserCircleIcon aria-hidden="true" />,
    id: "recommendations",
    label: "Recommendations",
    to: "/recommendations",
  },
];

/** The rows that actually render: the live doors, never a future one. */
const liveMenuLinks = CREW_MENU_LINKS.filter((link) => !link.future);

/**
 * The signed-out CTA — the masthead's "Join the crew" button, relocated. Kept an
 * OUTLINE control wearing the moving glow (never a gold FILL), so the sweep never
 * competes with the Galaxy's one sun (DESIGN.md One Sun). The label collapses to the
 * glyph on a narrow bar, exactly as the search label does, so the top bar stays one
 * line; the accessible name rides on the Link either way.
 */
function JoinButton(): ReactNode {
  return (
    <Button
      className="crew-glow"
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
function AccountMenu({ name }: { name: string }): ReactNode {
  async function signOut() {
    await authClient.signOut();
    // A full reload is the cleanest way to flush EVERY signed-in surface at once —
    // this trigger reacts to the session atom on its own, but the account page reads
    // `/api/me` in an effect, so only a reload guarantees it re-reads signed-out.
    globalThis.location.reload();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Your account" className="crew-trigger">
        <UsersThreeIcon aria-hidden="true" className="crew-trigger-icon" weight="bold" />
        <span className="crew-slot-label">{name}</span>
        <CaretDownIcon aria-hidden="true" className="crew-trigger-caret" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>Signed in as {name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {liveMenuLinks.map((link) => (
          <DropdownMenuItem
            key={link.id}
            render={
              link.search ? (
                <Link search={link.search as never} to={link.to as never} />
              ) : (
                <Link to={link.to as never} />
              )
            }
          >
            {link.icon}
            {link.label}
          </DropdownMenuItem>
        ))}
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
 */
export function CrewSlot(): ReactNode {
  const { data: session } = authClient.useSession();
  const user = session?.user;

  if (!user) {
    return <JoinButton />;
  }

  const name = user.displayUsername ?? user.username ?? user.name ?? "cosmonaut";

  return <AccountMenu name={name} />;
}

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
// The menu is built to GROW. Two more doors are coming — ChatDnB and the
// per-listener recommendation engine — and they live below as FUTURE slots:
// present in the model, flagged, and filtered OUT of the render so no dead link
// ever ships. The day their route lands, delete the one `future` flag and the door
// lights up. Same discipline as the nav model's `future` slot (lib/nav-model.ts).

import {
  BinocularsIcon,
  BookmarkSimpleIcon,
  CaretDownIcon,
  ChatCircleDotsIcon,
  GearSixIcon,
  SignOutIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
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
 * - LIVE: a door into `/account` (optionally onto one of its tabs). The route is
 *   the literal `/account` at the render site, so these links keep their
 *   compile-time route check.
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
    }
  | { future: true; icon: ReactNode; id: string; label: string; to: string };

const CREW_MENU_LINKS: CrewMenuLink[] = [
  { icon: <UserCircleIcon aria-hidden="true" />, id: "account", label: "My account" },
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
  // ── EXTENSION SLOTS ─────────────────────────────────────────────────────────
  // Two more doors are planned. They are FILTERED OUT while `future` is set (so no
  // dead link ships); remove the flag the day the route exists to light one up. The
  // `to` values are provisional placeholders — set the real path when it lands.
  {
    future: true,
    icon: <ChatCircleDotsIcon aria-hidden="true" />,
    id: "chatdnb",
    label: "ChatDnB",
    to: "/chat",
  },
  {
    future: true,
    icon: <BinocularsIcon aria-hidden="true" />,
    id: "recommendations",
    label: "Recommendations",
    to: "/recommendations",
  },
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
        <UserCircleIcon aria-hidden="true" className="crew-trigger-icon" weight="bold" />
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
              link.search ? <Link search={link.search} to="/account" /> : <Link to="/account" />
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
 * `home` gates the Join glow to the one page it was designed for.
 */
export function CrewSlot({ home }: { home: boolean }): ReactNode {
  const { data: session } = authClient.useSession();
  const user = session?.user;

  if (!user) {
    return <JoinButton glow={home} />;
  }

  const name = user.displayUsername ?? user.username ?? user.name ?? "cosmonaut";

  return <AccountMenu name={name} />;
}

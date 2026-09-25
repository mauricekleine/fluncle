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

type AccountTab = "saves" | "settings";

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
  { icon: <PlanetIcon aria-hidden="true" />, id: "galaxy", label: "Galaxy" },
  {
    icon: <BookmarkSimpleIcon aria-hidden="true" />,
    id: "saves",
    label: "Saves",
    search: { tab: "saves" },
  },

  {
    icon: <ChatCircleDotsIcon aria-hidden="true" />,
    id: "chatdnb",
    label: "ChatDnB",
    to: "/chat",
  },

  {
    icon: <BinocularsIcon aria-hidden="true" />,
    id: "recommendations",
    label: "Recommendations",
    to: "/recommendations",
  },

  {
    icon: <GearSixIcon aria-hidden="true" />,
    id: "settings",
    label: "Settings",
    search: { tab: "settings" },
  },
];

const liveMenuLinks = CREW_MENU_LINKS.filter(
  (link): link is Extract<CrewMenuLink, { future?: undefined }> => !link.future,
);

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

function AccountMenu({ image, name }: { image: null | string; name: string }): ReactNode {
  async function signOut() {
    await authClient.signOut();

    globalThis.location.reload();
  }

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
          <img alt="" className="crew-trigger-avatar" src={image} />
        ) : (
          <UserCircleIcon aria-hidden="true" className="crew-trigger-icon" weight="bold" />
        )}
        <span className="crew-slot-label">{name}</span>
        <CaretDownIcon aria-hidden="true" className="crew-trigger-caret" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
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

export function CrewSlot({ home }: { home: boolean }): ReactNode {
  const { data: session } = authClient.useSession();
  const user = session?.user;

  if (!user) {
    return <JoinButton glow={home} />;
  }

  const name = user.name || (user.displayUsername ?? user.username ?? "cosmonaut");

  return <AccountMenu image={user.image ?? null} name={name} />;
}

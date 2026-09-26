import {
  BinocularsIcon,
  BookmarkSimpleIcon,
  ChatCircleDotsIcon,
  GearSixIcon,
  PlanetIcon,
  SignOutIcon,
} from "@phosphor-icons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode } from "react";
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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

export function CrewMenuContent({ name }: { name: string }): ReactNode {
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

  async function signOut(): Promise<void> {
    await authClient.signOut();

    globalThis.location.reload();
  }

  return (
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
  );
}

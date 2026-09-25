import {
  CassetteTapeIcon,
  ChartLineUpIcon,
  ChatCircleDotsIcon,
  ChatTeardropTextIcon,
  CurrencyDollarIcon,
  FilmReelIcon,
  FilmSlateIcon,
  FilmStripIcon,
  FunnelIcon,
  GearSixIcon,
  type Icon,
  ListNumbersIcon,
  PaperPlaneTiltIcon,
  PlanetIcon,
  PulseIcon,
  ReceiptIcon,
  SignOutIcon,
  SquaresFourIcon,
  TagIcon,
  BinocularsIcon,
  UserCircleIcon,
  UsersThreeIcon,
  VinylRecordIcon,
  WaveTriangleIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useId } from "react";
import { Label } from "@fluncle/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@fluncle/ui/components/popover";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@fluncle/ui/components/sidebar";
import { Button } from "@fluncle/ui/components/button";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listTracks } from "@/lib/server/tracks";

export type AdminNavCurrent =
  | "artists"
  | "catalogue"
  | "chat"
  | "clips"
  | "costs"
  | "dashboard"
  | "findings"
  | "funnel"
  | "galaxies"
  | "labels"
  | "mixable-order"
  | "mixtapes"
  | "newsletter"
  | "plans"
  | "prompts"
  | "reach"
  | "recordings"
  | "renders"
  | "system"
  | "usage"
  | "users";

type AdminNavPath =
  | "/admin"
  | "/admin/artists"
  | "/admin/catalogue"
  | "/admin/chat"
  | "/admin/clips"
  | "/admin/costs"
  | "/admin/findings"
  | "/admin/funnel"
  | "/admin/galaxies"
  | "/admin/labels"
  | "/admin/mixable-order"
  | "/admin/mixtapes"
  | "/admin/newsletter"
  | "/admin/plans"
  | "/admin/prompts"
  | "/admin/reach"
  | "/admin/recordings"
  | "/admin/renders"
  | "/admin/usage"
  | "/admin/users"
  | "/status";

type NavEntry = {
  count?: keyof NavCounts;
  icon: Icon;
  key: AdminNavCurrent;
  label: string;
  to: AdminNavPath;
};

const HOME_ENTRY: NavEntry = {
  icon: SquaresFourIcon,
  key: "dashboard",
  label: "Dashboard",
  to: "/admin",
};

type NavSection = {
  entries: NavEntry[];

  key: string;

  label?: string;
};

const OBJECT_SECTIONS: NavSection[] = [
  {
    entries: [
      {
        icon: VinylRecordIcon,
        key: "findings",
        label: "Findings",
        to: "/admin/findings",
      },
      {
        count: "renderQueue",
        icon: FilmReelIcon,
        key: "renders",
        label: "Renders",
        to: "/admin/renders",
      },
      { icon: UsersThreeIcon, key: "artists", label: "Artists", to: "/admin/artists" },
      { icon: PlanetIcon, key: "galaxies", label: "Galaxies", to: "/admin/galaxies" },
    ],
    key: "objects",
  },

  {
    entries: [
      { icon: FunnelIcon, key: "funnel", label: "Funnel", to: "/admin/funnel" },

      { icon: BinocularsIcon, key: "catalogue", label: "The Ear", to: "/admin/catalogue" },
      { icon: TagIcon, key: "labels", label: "Labels", to: "/admin/labels" },
    ],
    key: "catalogue",
    label: "Catalogue",
  },
  {
    entries: [
      { icon: ListNumbersIcon, key: "plans", label: "Playlists", to: "/admin/plans" },
      { icon: CassetteTapeIcon, key: "mixtapes", label: "Mixtapes", to: "/admin/mixtapes" },
      {
        icon: WaveTriangleIcon,
        key: "mixable-order",
        label: "Dream-weaver",
        to: "/admin/mixable-order",
      },
    ],
    key: "sets",
    label: "Sets",
  },
  {
    entries: [
      { icon: FilmSlateIcon, key: "recordings", label: "Recordings", to: "/admin/recordings" },
      { icon: FilmStripIcon, key: "clips", label: "Clips", to: "/admin/clips" },
    ],
    key: "studio",
    label: "Studio",
  },
  {
    entries: [
      {
        icon: PaperPlaneTiltIcon,
        key: "newsletter",
        label: "Newsletter",
        to: "/admin/newsletter",
      },

      { icon: ChartLineUpIcon, key: "reach", label: "Reach", to: "/admin/reach" },
    ],
    key: "publish",
  },
  {
    entries: [
      { icon: UserCircleIcon, key: "users", label: "Users", to: "/admin/users" },
      { icon: ReceiptIcon, key: "costs", label: "Costs", to: "/admin/costs" },
      { icon: CurrencyDollarIcon, key: "usage", label: "Usage & cost", to: "/admin/usage" },
    ],
    key: "ops",
    label: "Ops",
  },
];

const SYSTEM_ENTRIES: NavEntry[] = [
  {
    icon: ChatCircleDotsIcon,
    key: "chat",
    label: "ChatDnB",
    to: "/admin/chat",
  },
  {
    icon: ChatTeardropTextIcon,
    key: "prompts",
    label: "Prompts",
    to: "/admin/prompts",
  },
  {
    icon: PulseIcon,
    key: "system",
    label: "System",
    to: "/status",
  },
];

const ALL_ENTRIES: NavEntry[] = [
  HOME_ENTRY,
  ...OBJECT_SECTIONS.flatMap((section) => section.entries),
  ...SYSTEM_ENTRIES,
];

export function navKeyForPath(pathname: string): AdminNavCurrent {
  if (pathname === "/admin/studio" || pathname.startsWith("/admin/studio/")) {
    return "recordings";
  }

  const exact = ALL_ENTRIES.find((entry) => entry.to === pathname);
  if (exact) {
    return exact.key;
  }

  const prefixed = ALL_ENTRIES.filter(
    (entry) => entry.to !== "/admin" && pathname.startsWith(`${entry.to}/`),
  ).sort((a, b) => b.to.length - a.to.length)[0];

  return prefixed?.key ?? "dashboard";
}

type NavCounts = { renderQueue: number };

const NAV_COUNTS_KEY = ["admin", "nav", "counts"] as const;

const fetchNavCounts = createServerFn({ method: "GET" }).handler(
  async (): Promise<NavCounts | null> => {
    if (!(await isAdminRequest())) {
      return null;
    }

    const renders = await listTracks({ hasContext: true, hasVideo: false, limit: 1 });

    return { renderQueue: renders.totalCount };
  },
);

export function AdminSidebar({ current }: { current: AdminNavCurrent }) {
  const { data: counts } = useQuery({
    queryFn: () => fetchNavCounts(),
    queryKey: NAV_COUNTS_KEY,
    refetchOnWindowFocus: true,
  });

  const renderEntry = (entry: NavEntry) => {
    const active = entry.key === current;
    const count = entry.count ? (counts?.[entry.count] ?? 0) : 0;
    const EntryIcon = entry.icon;

    return (
      <SidebarMenuItem key={entry.key}>
        <SidebarMenuButton
          isActive={active}
          render={
            <Link
              aria-current={active ? "page" : undefined}

              aria-label={count > 0 ? `${entry.label} (${count})` : undefined}
              to={entry.to}
            />
          }
          tooltip={entry.label}
        >
          <EntryIcon aria-hidden="true" weight={active ? "fill" : "regular"} />
          <span>{entry.label}</span>
        </SidebarMenuButton>
        {count > 0 ? (
          <SidebarMenuBadge aria-hidden="true" className="text-muted-foreground">
            {count}
          </SidebarMenuBadge>
        ) : undefined}
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar collapsible="icon" variant="floating">
      <SidebarHeader>
        <Link
          className="flex items-center gap-2 rounded-md p-1 focus-visible:ring-3 focus-visible:ring-ring/50 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
          to="/admin"
        >
          <span className="admin-brand-chip size-8 shrink-0">
            <img alt="Fluncle admin" src="/fluncle-transparant.png" />
          </span>
          <span aria-hidden="true" className="admin-wordmark group-data-[collapsible=icon]:hidden">
            Fluncle <span className="text-muted-foreground">admin</span>
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Admin" className="contents">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>{renderEntry(HOME_ENTRY)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {OBJECT_SECTIONS.map((section) => (
            <SidebarGroup key={section.key}>
              {section.label ? <SidebarGroupLabel>{section.label}</SidebarGroupLabel> : null}
              <SidebarGroupContent>
                <SidebarMenu>{section.entries.map(renderEntry)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}

          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <SidebarMenu>{SYSTEM_ENTRIES.map(renderEntry)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <KeyNotationCog />
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<a aria-label="Sign out" href="/api/v1/admin/logout" />}
              tooltip="Sign out"
            >
              <SignOutIcon aria-hidden="true" />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

const NOTATION_OPTIONS: { label: string; value: KeyNotation }[] = [
  { label: "Scales", value: "scales" },
  { label: "Camelot", value: "camelot" },
];

function KeyNotationCog() {
  const { notation, setNotation } = useKeyNotation();
  const labelId = useId();

  return (
    <SidebarMenuItem>
      <Popover>
        <PopoverTrigger
          render={
            <SidebarMenuButton tooltip="Display settings">
              <GearSixIcon aria-hidden="true" />
              <span>Display settings</span>
            </SidebarMenuButton>
          }
        />
        <PopoverContent align="end" className="w-64 space-y-3" side="right">
          <div className="space-y-1.5">
            <Label id={labelId}>Key notation</Label>
            {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a labelled set of toggle buttons in a popover, not a form control group; `fieldset`/`legend` would be wrong markup here. */}
            <div aria-labelledby={labelId} className="flex gap-1.5" role="group">
              {NOTATION_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  aria-pressed={notation === option.value}
                  className="flex-1"
                  onClick={() => setNotation(option.value)}
                  size="sm"
                  variant={notation === option.value ? "secondary" : "outline"}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              How keys read across the admin. Camelot is the wheel for harmonic mixing.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}

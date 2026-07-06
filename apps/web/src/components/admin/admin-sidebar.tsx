import {
  CassetteTapeIcon,
  FilmSlateIcon,
  FilmStripIcon,
  GearSixIcon,
  type Icon,
  ListNumbersIcon,
  PaperPlaneTiltIcon,
  PulseIcon,
  SignOutIcon,
  SquaresFourIcon,
  VinylRecordIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
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

// The admin sidebar — the one navigation surface of the admin workspace
// (docs/admin-shell.md). One flat object nav: every kind of thing the operator
// works on is an entry, whether or not it has its own station yet. An entry
// whose station doesn't exist points at the best CURRENT home for that object
// and only lights up once a page declares it as its owner key — so the nav is
// stable across waves while stations land behind it.
//
// Owner keys today: `/admin` (the attention queue, the landing) → dashboard;
// `/admin/findings` (the pipeline board) → findings; `/admin/plans` → plans;
// `/admin/clips` → clips; `/admin/newsletter` → newsletter; the Studio
// (`/admin/studio/$recordingId`, a recording's workstation) → recordings.
// Recordings' list home is the recordings index on Clips; Mixtapes' closest home
// is Plans (where a take is promoted); System is the live service map at /status.

/** A sidebar entry's key. A page passes the entry it OWNS as `current`. */
export type AdminNavCurrent =
  | "clips"
  | "dashboard"
  | "findings"
  | "mixtapes"
  | "newsletter"
  | "plans"
  | "recordings"
  | "system";

type NavEntry = {
  /** Which live count this entry carries, when a cheap read exists. */
  count?: keyof NavCounts;
  icon: Icon;
  key: AdminNavCurrent;
  label: string;
  to: string;
};

// The landing — the attention queue (docs/cockpit-roadmap.md, "The queue"):
// every action the system needs as a row; zero rows is the success state.
const HOME_ENTRY: NavEntry = {
  icon: SquaresFourIcon,
  key: "dashboard",
  label: "Dashboard",
  to: "/admin",
};

// The objects, in pipeline order: a finding is logged, planned into a set,
// captured as a recording, promoted to a mixtape, clipped, and written up.
const OBJECT_ENTRIES: NavEntry[] = [
  {
    count: "untagged",
    icon: VinylRecordIcon,
    key: "findings",
    label: "Findings",
    to: "/admin/findings",
  },
  { icon: ListNumbersIcon, key: "plans", label: "Plans", to: "/admin/plans" },
  { icon: FilmSlateIcon, key: "recordings", label: "Recordings", to: "/admin/clips" },
  { icon: CassetteTapeIcon, key: "mixtapes", label: "Mixtapes", to: "/admin/plans" },
  { icon: FilmStripIcon, key: "clips", label: "Clips", to: "/admin/clips" },
  {
    icon: PaperPlaneTiltIcon,
    key: "newsletter",
    label: "Newsletter",
    to: "/admin/newsletter",
  },
];

// The machine itself: the live service map, carrying the render backlog.
const SYSTEM_ENTRY: NavEntry = {
  count: "renderQueue",
  icon: PulseIcon,
  key: "system",
  label: "System",
  to: "/status",
};

// The two live counts with a cheap, honest server read TODAY (one scoped COUNT
// each): the tagging backlog (the operator's one manual gate — the board's
// "Needs tagging" worklist) and the render backlog (enriched findings still
// waiting on the box's video render). Unposted-to-TikTok has no cheap global
// read yet (posts join per-page); it arrives with the Wave-1 queue.
type NavCounts = { renderQueue: number; untagged: number };

const NAV_COUNTS_KEY = ["admin", "nav", "counts"] as const;

// Directly callable like every server fn, so it re-checks the grant itself and
// answers null (not a redirect) when unauthenticated — the sidebar only renders
// on guarded pages, and counts must never leak.
const fetchNavCounts = createServerFn({ method: "GET" }).handler(
  async (): Promise<NavCounts | null> => {
    if (!(await isAdminRequest())) {
      return null;
    }

    // The render queue uses the box's own canonical read (`fluncle admin
    // tracks queue`): findings with context but no video yet.
    const [untagged, renders] = await Promise.all([
      listTracks({ limit: 1, placement: "unplaced" }),
      listTracks({ hasContext: true, hasVideo: false, limit: 1 }),
    ]);

    return { renderQueue: renders.totalCount, untagged: untagged.totalCount };
  },
);

export function AdminSidebar({ current }: { current: AdminNavCurrent }) {
  // Fetched lazily on mount, then focus-refetched — tabbing back after a tagging
  // or render run brings the badges back honest without a reload.
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
            <a
              aria-current={active ? "page" : undefined}
              // The visible label plus the live count, so a screen reader hears
              // the number the badge shows (the badge div itself is presentational).
              aria-label={count > 0 ? `${entry.label} (${count})` : undefined}
              href={entry.to}
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
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <a
          className="admin-wordmark rounded-md px-2 py-1.5 focus-visible:ring-3 focus-visible:ring-ring/50 group-data-[collapsible=icon]:hidden"
          href="/admin"
        >
          Fluncle <span className="text-muted-foreground">admin</span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        {/* display: contents keeps SidebarContent's flex layout intact while
            giving assistive tech the navigation landmark. */}
        <nav aria-label="Admin" className="contents">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>{renderEntry(HOME_ENTRY)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>{OBJECT_ENTRIES.map(renderEntry)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <SidebarMenu>{renderEntry(SYSTEM_ENTRY)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <KeyNotationCog />
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<a aria-label="Sign out" href="/api/admin/logout" />}
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

// The admin display-settings cog: a quiet gear opening a popover of per-operator
// display preferences. Today it holds the key-notation toggle — musical scales
// (default) vs the Camelot wheel DJs mix by — which flips every admin key
// readout live via the useKeyNotation store.
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

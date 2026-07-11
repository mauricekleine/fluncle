import {
  CassetteTapeIcon,
  CurrencyDollarIcon,
  FilmReelIcon,
  FilmSlateIcon,
  FilmStripIcon,
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

// The admin sidebar — the one navigation surface of the admin workspace
// (docs/admin-shell.md). The object nav: every kind of thing the operator works
// on is an entry, whether or not it has its own station yet. An entry whose
// station doesn't exist points at the best CURRENT home for that object and only
// lights up once a page declares it as its owner key — so the nav is stable
// across waves while stations land behind it. Entries are grouped into sections
// (ADM-01): a section renders as a Shadcn SidebarGroup, and a labelled section
// gets a SidebarGroupLabel above it. The "Sets" group holds the set-level objects
// (Playlists → Mixtapes); the "Studio" group (ADM-03) holds Recordings + Clips.
//
// Owner keys today: `/admin` (the attention queue, the landing) → dashboard;
// `/admin/findings` (the pipeline board) → findings; `/admin/renders` → renders;
// `/admin/plans` → plans (labelled "Playlists"); `/admin/recordings` (the
// recordings index + the uploader) → recordings; `/admin/clips` (the clip library +
// the drip kill-switch) → clips; `/admin/newsletter` → newsletter. A recording's
// per-set workstation is the Studio (`/admin/studio/$recordingId`), opened from a
// Recordings row. `/admin/mixtapes` (the minted-mixtape index + distribution
// links) → mixtapes; `/admin/costs` (the operator's private cost ledger) → costs;
// System is the live service map at /status.

/** A sidebar entry's key. A page passes the entry it OWNS as `current`. */
export type AdminNavCurrent =
  | "artists"
  | "clips"
  | "costs"
  | "dashboard"
  | "findings"
  | "galaxies"
  | "labels"
  | "mixable-order"
  | "mixtapes"
  | "newsletter"
  | "plans"
  | "recordings"
  | "renders"
  | "system"
  | "usage";

// The nav targets, as literal route paths so each entry renders a typed TanStack
// <Link> (client-side navigation, not a full document reload — the whole point of
// the persistent shell). All are param-less; System deep-links the /status page.
type AdminNavPath =
  | "/admin"
  | "/admin/artists"
  | "/admin/clips"
  | "/admin/costs"
  | "/admin/findings"
  | "/admin/galaxies"
  | "/admin/labels"
  | "/admin/mixable-order"
  | "/admin/mixtapes"
  | "/admin/newsletter"
  | "/admin/plans"
  | "/admin/recordings"
  | "/admin/renders"
  | "/admin/usage"
  | "/status";

type NavEntry = {
  /** Which live count this entry carries, when a cheap read exists. */
  count?: keyof NavCounts;
  icon: Icon;
  key: AdminNavCurrent;
  label: string;
  to: AdminNavPath;
};

// The landing — the attention queue: every action the system needs as a row;
// zero rows is the success state.
const HOME_ENTRY: NavEntry = {
  icon: SquaresFourIcon,
  key: "dashboard",
  label: "Dashboard",
  to: "/admin",
};

// A group of object entries. A section renders as one Shadcn SidebarGroup; a
// `label` renders a SidebarGroupLabel above the entries (else the group is
// unlabelled and reads as it did before).
type NavSection = {
  entries: NavEntry[];
  /** Stable React key for the section. */
  key: string;
  /** The group heading. Omit for an unlabelled group. */
  label?: string;
};

// The objects, in pipeline order: a finding is logged, filmed into a render,
// planned into a set, captured as a recording, promoted to a mixtape, clipped, and
// written up. Renders sits with Findings (its object is a finding's video) and
// carries the render backlog badge — the count's dedicated home now it has a page.
//
// "Sets" is the set-level objects: a Playlist (a plan) is lined up first and
// promoted into a Mixtape, so Playlists leads. "Studio" (between Sets and
// Newsletter) holds the capture-and-clip objects: a Recording is uploaded and
// opened into its per-set Studio, then its cuts land in the Clips library.
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
      { icon: TagIcon, key: "labels", label: "Labels", to: "/admin/labels" },
      { icon: PlanetIcon, key: "galaxies", label: "Galaxies", to: "/admin/galaxies" },
    ],
    key: "objects",
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
    ],
    key: "publish",
  },
  {
    entries: [
      { icon: ReceiptIcon, key: "costs", label: "Costs", to: "/admin/costs" },
      { icon: CurrencyDollarIcon, key: "usage", label: "Usage & cost", to: "/admin/usage" },
    ],
    key: "ops",
    label: "Ops",
  },
];

// The machine itself: the live service map. The render backlog badge moved to the
// Renders entry (its dedicated page); System stays the deep-link to /status.
const SYSTEM_ENTRY: NavEntry = {
  icon: PulseIcon,
  key: "system",
  label: "System",
  to: "/status",
};

// Every entry, flat — the lookup table behind navKeyForPath.
const ALL_ENTRIES: NavEntry[] = [
  HOME_ENTRY,
  ...OBJECT_SECTIONS.flatMap((section) => section.entries),
  SYSTEM_ENTRY,
];

// Which nav entry a pathname belongs to. The shell is mounted ONCE in the /admin
// layout now (route.tsx), above the Outlet, so it can't be told the active entry
// by each page — it resolves it from the URL instead. The Studio has no entry of
// its own; it's opened from a Recordings row and lights Recordings (the comment
// above). Exact match wins first so "/admin" → dashboard never swallows a deeper
// path; otherwise the longest `to` that prefixes the path lights its entry, so a
// future nested station lights its parent.
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

// The live count with a cheap, honest server read TODAY (one scoped COUNT): the
// render backlog (enriched findings still waiting on the box's video render). The
// old "needs tagging" badge is gone with manual vibe-tagging — a finding's placement
// is now the sonic galaxy the cluster cron assigns, not an operator gate.
// Unposted-to-TikTok has no cheap global read yet (posts join per-page).
type NavCounts = { renderQueue: number };

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
    const renders = await listTracks({ hasContext: true, hasVideo: false, limit: 1 });

    return { renderQueue: renders.totalCount };
  },
);

export function AdminSidebar({ current }: { current: AdminNavCurrent }) {
  // Fetched lazily on mount, then focus-refetched — tabbing back after a render
  // run brings the badge back honest without a reload.
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
              // The visible label plus the live count, so a screen reader hears
              // the number the badge shows (the badge div itself is presentational).
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
        {/* The nameplate + home link. The circular brand chip shows ALWAYS — the
            mark alongside the wordmark when expanded, and the mark alone once the
            rail collapses to icons (the wordmark hides, the chip stays, sized to
            the icon-button footprint). The chip is a light disc so the mostly-dark
            Fluncle art reads against the dark sidebar; the img alt carries the
            link's accessible name in both states, so the visible wordmark is
            marked decorative to avoid a doubled reading. */}
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
        {/* display: contents keeps SidebarContent's flex layout intact while
            giving assistive tech the navigation landmark. */}
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

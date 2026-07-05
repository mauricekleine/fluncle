// The Helm shell — header (nameplate + machine badge), the station rail (the
// machine-gated feature manifests), the active panel, and the run drawer. The
// shell knows nothing about any feature beyond the contract: manifests come from
// /api/features, panels lazy-load from src/features/<id>/panel.tsx by convention.

import { CompassRose } from "@phosphor-icons/react";
import {
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { Badge } from "@fluncle/ui/components/badge";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { cn } from "@fluncle/ui/lib/utils";

import { type MachineResponse, type RunsResponse, type RunSummary } from "../contract";
import { type FeatureManifest } from "../features/types";
import { apiGet } from "./api";
import { HelmProvider, type HelmShellContext } from "./helm-context";
import { RunDrawer, type SelectedRun } from "./run-drawer";

const RUNS_POLL_MS = 5000;

// One lazy component per feature id, memoized so the panel keeps its identity
// across renders. The template literal is static-analyzable: Vite pre-bundles
// every src/features/*/panel.tsx behind it.
const panelCache = new Map<string, LazyExoticComponent<ComponentType>>();

function panelFor(id: string): LazyExoticComponent<ComponentType> {
  const cached = panelCache.get(id);

  if (cached) {
    return cached;
  }

  const panel = lazy(
    () => import(`../features/${id}/panel.tsx`) as Promise<{ default: ComponentType }>,
  );
  panelCache.set(id, panel);

  return panel;
}

export function App() {
  const [machine, setMachine] = useState<MachineResponse>({ brand: "", machine: "unknown" });
  const [features, setFeatures] = useState<FeatureManifest[] | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<SelectedRun | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [machineResponse, featuresResponse] = await Promise.all([
        apiGet<MachineResponse>("/api/machine"),
        apiGet<{ features: FeatureManifest[] }>("/api/features"),
      ]);

      if (cancelled) {
        return;
      }

      setMachine(machineResponse);
      setFeatures(featuresResponse.features);
      setActiveId((current) => current ?? featuresResponse.features[0]?.id);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const response = await apiGet<RunsResponse>("/api/runs");
      setRuns(response.runs);
    } catch {
      // The daemon will answer the next tick; a missed poll is not a state.
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
    const timer = setInterval(() => void refreshRuns(), RUNS_POLL_MS);

    return () => clearInterval(timer);
  }, [refreshRuns]);

  const openRun = useCallback(
    (feature: string, runId: string) => {
      setSelectedRun({ feature, runId });
      setDrawerOpen(true);
      void refreshRuns();
    },
    [refreshRuns],
  );

  const shellContext: HelmShellContext = useMemo(
    () => ({ machine: machine.machine, machineBrand: machine.brand, openRun }),
    [machine.brand, machine.machine, openRun],
  );

  const active = features?.find((feature) => feature.id === activeId);
  const Panel = active ? panelFor(active.id) : undefined;

  return (
    <HelmProvider value={shellContext}>
      <div className="flex h-dvh flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-5 py-3">
          <div className="flex items-baseline gap-3">
            <CompassRose aria-hidden className="size-4 self-center text-muted-foreground" />
            <h1 className="helm-nameplate">Fluncle&rsquo;s Helm</h1>
            <p className="text-xs text-muted-foreground max-sm:hidden">
              Mission control for the rig.
            </p>
          </div>
          <Badge className="font-display tracking-wide" title={machine.brand} variant="outline">
            {machine.machine === "unknown" ? "machine unknown" : machine.machine.toUpperCase()}
          </Badge>
        </header>

        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <nav
            aria-label="Stations"
            className="helm-scroll w-52 shrink-0 overflow-y-auto border-r p-3 max-md:flex max-md:w-full max-md:gap-1 max-md:overflow-x-auto max-md:border-r-0 max-md:border-b"
          >
            <ul className="grid w-full gap-0.5 max-md:flex">
              {(features ?? []).map((feature) => (
                <li key={feature.id}>
                  <button
                    aria-current={feature.id === activeId ? "page" : undefined}
                    className={cn(
                      "w-full rounded-md px-3 py-2 text-left text-sm transition-colors max-md:whitespace-nowrap",
                      feature.id === activeId
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                    onClick={() => setActiveId(feature.id)}
                    type="button"
                  >
                    {feature.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <main className="helm-scroll min-h-0 flex-1 overflow-y-auto p-6">
            {features === undefined ? (
              <ShellSkeleton />
            ) : Panel ? (
              <Suspense fallback={<ShellSkeleton />}>
                <Panel />
              </Suspense>
            ) : (
              <NoStations />
            )}
          </main>
        </div>

        <RunDrawer
          onSelect={setSelectedRun}
          onToggle={setDrawerOpen}
          open={drawerOpen}
          runs={runs}
          selected={selectedRun}
        />
      </div>
    </HelmProvider>
  );
}

function ShellSkeleton() {
  return (
    <div className="grid max-w-2xl gap-3">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-9 w-56" />
    </div>
  );
}

// The empty state, read off a recovered terminal (VOICE.md, the Depth Gradient):
// deadpan machine states, said not written.
function NoStations() {
  return (
    <div className="grid h-full place-items-center">
      <div className="font-mono text-[0.82rem] leading-relaxed">
        <p>
          <span className="text-muted-foreground">[dark]&nbsp;</span> stations
          <span className="text-muted-foreground">{"    "}nothing wired to this machine yet</span>
        </p>
        <p>
          <span className="font-bold">[clear]</span> daemon
          <span className="text-muted-foreground">{"      "}holding</span>
        </p>
        <p className="mt-4 text-muted-foreground">
          A station is three files in src/features and one line in the registry.
        </p>
        <p className="text-muted-foreground">Wire one in and it lights up here.</p>
      </div>
    </div>
  );
}

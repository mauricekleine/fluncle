// The shell's context for feature panels. A panel gets the detected machine and
// `openRun` — hand it a feature + runId right after starting an action and the
// run drawer opens on that stream. Panels never talk to the drawer directly.

import { createContext, useContext } from "react";

import { type MachineId } from "../contract";

export type HelmShellContext = {
  machine: MachineId;
  machineBrand: string;
  /** Open the run drawer on a run (usually the one your action just started). */
  openRun: (feature: string, runId: string) => void;
};

const HelmContext = createContext<HelmShellContext | undefined>(undefined);

export const HelmProvider = HelmContext.Provider;

export function useHelm(): HelmShellContext {
  const value = useContext(HelmContext);

  if (!value) {
    throw new Error("useHelm wants a HelmProvider above it — panels render inside the shell");
  }

  return value;
}

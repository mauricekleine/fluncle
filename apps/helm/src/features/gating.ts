// Machine gating — which stations this Mac's helm shows. Pure and shared: the
// daemon gates /api/features with it, and the tests pin the behaviour.

import { type MachineId } from "../contract";
import { type FeatureManifest } from "./types";

/**
 * The manifests visible on `machine`, rail order (ascending `order`, then id).
 * An unknown machine shows everything: an operator on an undetected Mac is never
 * locked out — the header badge says "unknown" and the operator knows their rig.
 */
export function visibleFeatures(
  manifests: readonly FeatureManifest[],
  machine: MachineId,
): FeatureManifest[] {
  const visible = manifests.filter((manifest) => featureAllowedOnMachine(manifest, machine));

  return visible.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * May this feature ACT on this machine? The same rule the panel gate uses, held
 * server-side too: the daemon 403s a wrong-machine action POST, so a request
 * aimed straight at the API (no panel involved) meets the same wall. An unknown
 * machine gates nothing, matching visibility.
 */
export function featureAllowedOnMachine(manifest: FeatureManifest, machine: MachineId): boolean {
  return machine === "unknown" || manifest.machines.includes(machine);
}

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
  const visible =
    machine === "unknown"
      ? [...manifests]
      : manifests.filter((manifest) => manifest.machines.includes(machine));

  return visible.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// Which Mac is this? The two-machine rig (AGENTS.md "Which machine am I on?"):
// detect with `sysctl -n machdep.cpu.brand_string` and key loosely off the chip
// generation — "Apple M5 Pro" → m5, "Apple M2" → m2, anything else → unknown.
// The daemon detects once at boot; features gate their visibility on the answer.

import { type MachineId } from "../contract";

/** Pure parse of the sysctl brand string — the testable half of detection. */
export function parseMachine(brand: string): MachineId {
  if (brand.includes("M5")) {
    return "m5";
  }

  if (brand.includes("M2")) {
    return "m2";
  }

  return "unknown";
}

export type DetectedMachine = {
  brand: string;
  machine: MachineId;
};

/**
 * Ask the machine itself. Absolute /usr/sbin/sysctl so the answer survives
 * launchd's minimal PATH; any failure reads as unknown, never a crash — a helm
 * that can't name its machine still holds.
 */
export async function detectMachine(): Promise<DetectedMachine> {
  try {
    const proc = Bun.spawn(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return { brand: "", machine: "unknown" };
    }

    const brand = output.trim();

    return { brand, machine: parseMachine(brand) };
  } catch {
    return { brand: "", machine: "unknown" };
  }
}

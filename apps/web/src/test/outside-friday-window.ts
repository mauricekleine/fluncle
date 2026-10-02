import { vi } from "vitest";
import {
  FRONTIER_REFRESH_GATE_END_HOUR,
  FRONTIER_REFRESH_GATE_START_HOUR,
  isWithinFrontierRefreshWindow,
} from "@/lib/server/anchor-spotify-search";

const WINDOW_MS = (FRONTIER_REFRESH_GATE_END_HOUR - FRONTIER_REFRESH_GATE_START_HOUR) * 3_600_000;

export function stepOutsideFridayWindow(): void {
  if (isWithinFrontierRefreshWindow(new Date())) {
    vi.useFakeTimers({ now: Date.now() + WINDOW_MS, toFake: ["Date"] });
  }
}

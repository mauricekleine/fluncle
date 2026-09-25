import { type CaptureBudgetResponse, type CaptureBudgetState } from "@fluncle/contracts";
import { adminApiGet, adminApiPut } from "../api";

export async function captureBudgetCommand(): Promise<CaptureBudgetState> {
  return adminApiGet<CaptureBudgetResponse>("/api/v1/admin/catalogue/capture-budget");
}

export async function setCaptureBudgetCommand(input: {
  dailyBytes?: number;
  dailyTracks?: number;
  paused?: boolean;
}): Promise<CaptureBudgetState> {
  return adminApiPut<CaptureBudgetResponse>("/api/v1/admin/catalogue/capture-budget", input);
}

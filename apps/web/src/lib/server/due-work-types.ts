export type DueWorkSubjectType = "album" | "artist" | "label" | "track";

export type DueWorkReadRepairOutcome = {
  pendingBranch?: import("@fluncle/contracts").DueWorkPendingDetails["branch"];
  physicalConverged: boolean;
  sourceConverged: boolean;
};

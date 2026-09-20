export type DueWorkSubjectType = "album" | "artist" | "label" | "track";

/** Convergence of the source and physical repair lanes before a queue read. */
export type DueWorkReadRepairOutcome = { physicalConverged: boolean; sourceConverged: boolean };

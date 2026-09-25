import { type Rolldown } from "vite";

export const ENTRIES_AWARE_MERGE_THRESHOLD = 0;

export const clientChunkGroups: Rolldown.CodeSplittingGroup[] = [
  { name: "app", priority: 100, tags: ["$initial"] },
  {
    entriesAware: true,
    entriesAwareMergeThreshold: ENTRIES_AWARE_MERGE_THRESHOLD,
    name: "vendor",
    priority: 20,
    test: /node_modules[\\/]/,
  },
  {
    entriesAware: true,
    entriesAwareMergeThreshold: ENTRIES_AWARE_MERGE_THRESHOLD,
    name: "chunk",
    priority: 10,
  },
];

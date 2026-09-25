import { type BeatState, type UseBeatOptions, useBeat } from "./use-beat";

export const useDownbeat = (downbeats: number[], options: UseBeatOptions = {}): BeatState =>
  useBeat(downbeats, { decay: options.decay ?? 2.2 });

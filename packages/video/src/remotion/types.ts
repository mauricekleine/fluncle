export type EnergySample = {
  timeMs: number;

  energy: number;
};

export type CosmosTrack = {
  trackId: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;

  discoveredAt: string;
  note?: string;

  logId?: string;

  durationMs?: number;

  label?: string;

  isrc?: string;

  releaseDate?: string;

  contextNote?: string;

  texture?: string[];

  features?: {
    centroidHz?: number;

    highRatio?: number;

    midFlatness?: number;

    onsetRate?: number;

    subBassRatio?: number;
  };
};

export type CosmosAudio = {
  file: string;
  startMs: number;

  durationMs: number;
  bpm: number;

  bpmConfidence?: number;

  beatGrid: number[];

  downbeats?: number[];

  onsets: number[];

  dropMs?: number;

  dropCandidates?: { timeMs: number; score: number }[];
  energyCurve: EnergySample[];

  bassCurve: EnergySample[];

  midCurve: EnergySample[];

  trebleCurve: EnergySample[];

  fluxCurve?: EnergySample[];

  subCurve?: EnergySample[];

  kickCurve?: EnergySample[];

  snareCurve?: EnergySample[];

  airCurve?: EnergySample[];

  rawDynamicsHint?: { bass: number; mid: number; treble: number };
};

export type CosmosPalette = {
  background: string;

  ink: string;

  accent: string;

  glow: string;

  swatches: string[];
};

export type CosmosAspect = "portrait" | "landscape" | "square";

export type RenderVariant = {
  aspect: CosmosAspect;
  hideOverlay: boolean;
};

export type RenderVariants = Record<string, RenderVariant>;

export type NostalgicCosmosProps = {
  track: CosmosTrack;
  audio: CosmosAudio;
  palette: CosmosPalette;
  seed: number;

  hideOverlay?: boolean;

  aspect?: CosmosAspect;
};

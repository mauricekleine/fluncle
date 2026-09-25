const ACCEPTS_SAMPLING = /claude-(haiku-|3\b|3-|sonnet-4[.-][0-6]\b|opus-4[.-][0-6]\b)/;

export function samplingFor(model: string, temperature: number): { temperature?: number } {
  if (!model.includes("claude-")) {
    return { temperature };
  }

  return ACCEPTS_SAMPLING.test(model) ? { temperature } : {};
}

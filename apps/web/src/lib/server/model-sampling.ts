// Sampling parameters per model generation.
//
// The OpenRouter call sites (search filter, context distil, ChatDnB) default to Haiku 4.5, which
// accepts `temperature`. Their `OPENROUTER_*_MODEL` overrides are documented operator knobs, and
// the Claude 4.7+ and 5 generations reject sampling parameters outright (a 400). Every one of
// those call sites swallows a non-OK response into its degradation path — search silently loses
// its filter tier, the distil falls back to the raw note — so a `temperature` sent to a model
// that refuses it is a silent outage wearing a working answer's face. Send it only where it is
// accepted; everywhere else the model samples at its own default.

/** Model ids (OpenRouter `provider/model` with a dotted version, or a bare Anthropic id) that still accept sampling. */
const ACCEPTS_SAMPLING = /claude-(haiku-|3\b|3-|sonnet-4[.-][0-6]\b|opus-4[.-][0-6]\b)/;

/**
 * The `temperature` field for a request to `model`: `{ temperature }` when that model accepts
 * sampling parameters, `{}` when it rejects them. Spread it into the request body.
 */
export function samplingFor(model: string, temperature: number): { temperature?: number } {
  // A non-Claude model (an OpenRouter route to another vendor) accepts sampling as a rule; only
  // the Claude generations that removed it are held back.
  if (!model.includes("claude-")) {
    return { temperature };
  }

  return ACCEPTS_SAMPLING.test(model) ? { temperature } : {};
}

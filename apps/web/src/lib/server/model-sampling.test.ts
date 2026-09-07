import { describe, expect, it } from "vitest";
import { samplingFor } from "./model-sampling";

describe("samplingFor — temperature only where the model accepts it", () => {
  it("sends temperature to Haiku 4.5, the Worker default", () => {
    expect(samplingFor("anthropic/claude-haiku-4.5", 0)).toEqual({ temperature: 0 });
    expect(samplingFor("anthropic/claude-haiku-4.5", 0.4)).toEqual({ temperature: 0.4 });
  });

  it("sends temperature to the 4.6 generation, where it is still accepted", () => {
    expect(samplingFor("anthropic/claude-sonnet-4.6", 0.2)).toEqual({ temperature: 0.2 });
    expect(samplingFor("claude-opus-4-6", 0.2)).toEqual({ temperature: 0.2 });
  });

  it("omits temperature for the generations that reject it with a 400", () => {
    expect(samplingFor("anthropic/claude-sonnet-5", 0)).toEqual({});
    expect(samplingFor("anthropic/claude-opus-5", 0)).toEqual({});
    expect(samplingFor("anthropic/claude-opus-4.8", 0)).toEqual({});
    expect(samplingFor("anthropic/claude-opus-4.7", 0)).toEqual({});
    expect(samplingFor("claude-fable-5-1", 0)).toEqual({});
  });

  it("passes temperature through for a non-Claude route", () => {
    expect(samplingFor("z-ai/glm-5.2", 0.4)).toEqual({ temperature: 0.4 });
  });
});

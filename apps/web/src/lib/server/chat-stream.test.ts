import {
  type UIMessage,
  type UIMessageChunk,
  readUIMessageStream,
  simulateReadableStream,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";

const model = new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { id: "t", type: "text-start" },
        { delta: "oof, ", id: "t", type: "text-delta" },
        { delta: "that one", id: "t", type: "text-delta" },
        { id: "t", type: "text-end" },
        {
          finishReason: { raw: "stop", unified: "stop" },
          type: "finish",
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 3, total: 3 },
            outputTokens: { reasoning: 0, text: 2, total: 2 },
          },
        },
      ] as never,
    }),
  }),
});

vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: () => () => model }));
vi.mock("./env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readOptionalEnv: async () => "test-key",
}));

function parseSse(body: string): UIMessageChunk[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk);
}

it("streamChat streams the model reply as a UI message", async () => {
  const { streamChat } = await import("./chat");
  const response = await streamChat([
    { id: "1", parts: [{ text: "hi", type: "text" }], role: "user" },
  ] as never);

  expect(response?.status).toBe(200);

  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: simulateReadableStream({ chunks: parseSse((await response?.text()) ?? "") }),
  })) {
    last = message;
  }

  expect(last?.parts).toContainEqual({ state: "done", text: "oof, that one", type: "text" });
});

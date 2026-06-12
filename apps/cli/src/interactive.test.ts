import { describe, expect, test } from "bun:test";
import { selectWithKeyboard } from "./interactive";

class FakeInput {
  isRaw = false;
  isTTY = true;
  paused = false;
  resumed = false;
  rawModes: boolean[] = [];
  private listeners = new Set<(chunk: Buffer) => void>();

  emitData(value: string): void {
    for (const listener of this.listeners) {
      listener(Buffer.from(value));
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  off(event: "data", listener: (chunk: Buffer) => void): void {
    if (event === "data") {
      this.listeners.delete(listener);
    }
  }

  on(event: "data", listener: (chunk: Buffer) => void): void {
    if (event === "data") {
      this.listeners.add(listener);
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.resumed = true;
  }

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModes.push(mode);
  }
}

class FakeOutput {
  columns = 80;
  isTTY = true;
  chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  text(): string {
    return this.chunks.join("");
  }
}

describe("selectWithKeyboard", () => {
  test("moves with arrow keys, selects with enter, and restores terminal state", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();

    const selected = selectWithKeyboard(["one", "two", "three"], {
      input,
      nonInteractiveMessage: "interactive terminal required",
      output,
      renderLines: (items, selectedIndex) => [`selected:${items[selectedIndex]}`],
    });

    expect(input.resumed).toBe(true);
    expect(input.rawModes).toEqual([true]);
    expect(input.listenerCount()).toBe(1);
    expect(output.text()).toContain("selected:one");

    input.emitData("\u001b[B");
    expect(output.text()).toContain("selected:two");

    input.emitData("\r");
    expect(await selected).toBe("two");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listenerCount()).toBe(0);
    expect(output.text()).toContain("\x1b[?25h");
  });

  test("cancels with q and clears the rendered selector", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();

    const selected = selectWithKeyboard(["one"], {
      input,
      nonInteractiveMessage: "interactive terminal required",
      output,
      renderLines: (items, selectedIndex) => [`selected:${items[selectedIndex]}`],
    });

    input.emitData("q");

    expect(await selected).toBeUndefined();
    expect(output.text()).toContain("Cancelled.\n");
    expect(output.text()).toContain("\x1b[1F\x1b[J");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount()).toBe(0);
  });
});

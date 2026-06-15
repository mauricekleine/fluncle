import { describe, expect, test } from "bun:test";
import { paginateWithKeyboard, selectWithKeyboard } from "./interactive";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

describe("paginateWithKeyboard", () => {
  test("pages forward (fetch), back (cached), and restores the terminal on quit", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const calls: (string | undefined)[] = [];

    const done = paginateWithKeyboard({
      emptyMessage: "empty",
      fetchPage: async (cursor) => {
        calls.push(cursor);

        return cursor === "c1"
          ? { lines: ["b1", "b2"], total: 4 }
          : { lines: ["a1", "a2"], nextCursor: "c1", total: 4 };
      },
      input,
      nonInteractiveMessage: "nope",
      output,
    });

    await flush();
    expect(input.rawModes).toEqual([true]);
    expect(input.resumed).toBe(true);
    expect(output.text()).toContain("a1");
    expect(output.text()).toContain("1–2 of 4");

    input.emitData("\u001b[C");
    await flush();
    expect(calls).toEqual([undefined, "c1"]);
    expect(output.text()).toContain("b1");
    expect(output.text()).toContain("3–4 of 4");

    input.emitData("\u001b[D");
    await flush();
    expect(calls).toEqual([undefined, "c1"]);
    expect(output.text()).toContain("1–2 of 4");

    input.emitData("q");
    await done;
    expect(input.rawModes).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listenerCount()).toBe(0);
    expect(output.text()).toContain("\x1b[?25h");
  });

  test("shows the empty message and never enters raw mode for an empty archive", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();

    await paginateWithKeyboard({
      emptyMessage: "No findings logged yet.",
      fetchPage: async () => ({ lines: [], total: 0 }),
      input,
      nonInteractiveMessage: "nope",
      output,
    });

    expect(output.text()).toContain("No findings logged yet.");
    expect(input.rawModes).toEqual([]);
  });
});

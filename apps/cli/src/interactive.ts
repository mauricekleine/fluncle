import { createInterface } from "node:readline/promises";
import { CliError } from "./output";

type KeyboardSelectorOptions<T> = {
  input?: KeyboardInput;
  nonInteractiveMessage: string;
  output?: KeyboardOutput;
  renderLines: (items: T[], selectedIndex: number, columns: number) => string[];
};

type KeyboardInput = {
  isRaw?: boolean;
  isTTY?: boolean;
  off: (event: "data", listener: (chunk: Buffer) => void) => unknown;
  on: (event: "data", listener: (chunk: Buffer) => void) => unknown;
  pause: () => unknown;
  resume: () => unknown;
  setRawMode: (mode: boolean) => unknown;
};

type KeyboardOutput = {
  columns?: number;
  isTTY?: boolean;
  write: (chunk: string) => unknown;
};

export async function promptLine(label: string, nonInteractiveMessage: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("not_interactive", nonInteractiveMessage);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

export async function selectWithKeyboard<T>(
  items: T[],
  options: KeyboardSelectorOptions<T>,
): Promise<T | undefined> {
  const stdin = options.input ?? process.stdin;
  const stdout = options.output ?? process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new CliError("not_interactive", options.nonInteractiveMessage);
  }

  let selectedIndex = 0;
  let renderedLines = 0;
  let done = false;

  const wasRaw = stdin.isRaw === true;

  return await new Promise<T | undefined>((resolve) => {
    function cleanup(): void {
      if (done) {
        return;
      }

      done = true;
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\x1b[?25h");
    }

    function finish(item?: T): void {
      cleanup();
      stdout.write(renderedLines > 0 ? "\n" : "");
      resolve(item);
    }

    function cancel(): void {
      cleanup();
      clearRendered(stdout, renderedLines);
      stdout.write("Cancelled.\n");
      resolve(undefined);
    }

    function render(): void {
      clearRendered(stdout, renderedLines);
      const lines = options.renderLines(items, selectedIndex, stdout.columns ?? 80);
      renderedLines = lines.length;
      stdout.write(`${lines.join("\n")}\n`);
    }

    function onData(chunk: Buffer): void {
      const input = chunk.toString("utf8");

      if (input === "\u0003" || input === "\u001b" || input === "q") {
        cancel();
        return;
      }

      if (input === "\r" || input === "\n") {
        finish(items[selectedIndex]);
        return;
      }

      if (input === "\u001b[A" || input === "k") {
        selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (input === "\u001b[B" || input === "j") {
        selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
        render();
      }
    }

    stdout.write("\x1b[?25l");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

export function truncateTerminalLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 3, 0))}...`;
}

function clearRendered(stdout: KeyboardOutput, lineCount: number): void {
  if (lineCount === 0) {
    return;
  }

  stdout.write(`\x1b[${lineCount}F\x1b[J`);
}

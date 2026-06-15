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

type PagerPage = {
  lines: string[];
  nextCursor?: string;
  total: number;
};

type PaginateOptions = {
  emptyMessage: string;
  fetchPage: (cursor?: string) => Promise<PagerPage>;
  input?: KeyboardInput;
  nonInteractiveMessage: string;
  output?: KeyboardOutput;
};

/**
 * A keyboard-driven pager: shows one page of pre-rendered lines, then →/l/space
 * load the next page (fetched on demand via the cursor, then cached so ←/h is
 * instant), and q/Esc/Ctrl-C quit — leaving the last page on screen. Lines are
 * truncated to the terminal width so the in-place redraw never miscounts. Throws
 * `not_interactive` off a TTY; callers fall back to a plain print there.
 */
export async function paginateWithKeyboard(options: PaginateOptions): Promise<void> {
  const stdin = options.input ?? process.stdin;
  const stdout = options.output ?? process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new CliError("not_interactive", options.nonInteractiveMessage);
  }

  const first = await options.fetchPage(undefined);

  if (first.lines.length === 0) {
    stdout.write(`${options.emptyMessage}\n`);
    return;
  }

  const pages: PagerPage[] = [first];
  let index = 0;
  let renderedLines = 0;
  let busy = false;
  let done = false;

  const wasRaw = stdin.isRaw === true;

  return await new Promise<void>((resolve) => {
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

    function finish(): void {
      cleanup();
      stdout.write("\n");
      resolve();
    }

    function render(): void {
      clearRendered(stdout, renderedLines);

      const columns = stdout.columns ?? 80;
      const before = pages.slice(0, index).reduce((count, page) => count + page.lines.length, 0);
      const page = pages[index];
      const start = before + 1;
      const end = before + page.lines.length;
      const loading = busy ? "  ·  loading…" : "";
      const footer = `${start}–${end} of ${page.total}   ←/→ page · q quit${loading}`;
      const lines = [...page.lines, "", footer].map((line) => truncateTerminalLine(line, columns));

      renderedLines = lines.length;
      stdout.write(`${lines.join("\n")}\n`);
    }

    function loadNext(): void {
      const cursor = pages[index].nextCursor;

      if (cursor === undefined) {
        return;
      }

      busy = true;
      render();

      void options
        .fetchPage(cursor)
        .then((next) => {
          busy = false;

          if (next.lines.length > 0) {
            pages.push(next);
            index += 1;
          }

          render();
        })
        .catch(() => {
          busy = false;
          render();
        });
    }

    function onData(chunk: Buffer): void {
      if (busy) {
        return;
      }

      const input = chunk.toString("utf8");

      if (input === "\u0003" || input === "\u001b" || input === "q") {
        finish();
        return;
      }

      if (input === "\u001b[C" || input === "l" || input === " ") {
        if (index < pages.length - 1) {
          index += 1;
          render();
          return;
        }

        loadNext();
        return;
      }

      if (input === "\u001b[D" || input === "h") {
        if (index > 0) {
          index -= 1;
          render();
        }
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

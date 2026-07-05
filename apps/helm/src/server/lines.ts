// Line framing for streamed child output. Chunks arrive cut anywhere; the
// splitter buffers the tail until its newline lands, so a line is emitted exactly
// once and never torn. Pure — the unit-tested half of the run registry's pump.

export type LineSplitter = {
  /** Hand back the unterminated tail (process exited mid-line), if any. */
  flush(): string | undefined;
  /** Feed a chunk; get every newly completed line. */
  push(chunk: string): string[];
};

export function createLineSplitter(): LineSplitter {
  let rest = "";

  return {
    flush() {
      const tail = rest;
      rest = "";

      return tail.length > 0 ? stripCarriageReturn(tail) : undefined;
    },
    push(chunk) {
      rest += chunk;
      const parts = rest.split("\n");
      rest = parts.pop() ?? "";

      return parts.map(stripCarriageReturn);
    },
  };
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

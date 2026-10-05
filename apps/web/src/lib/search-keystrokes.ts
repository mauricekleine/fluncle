export type PendingKey = {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
};

export type PendingKeyAction =
  | { kind: "pass" }
  | { kind: "close" }
  | { kind: "swallow" }
  | { buffer: string; kind: "buffer" };

export function bufferPendingKey(buffer: string, event: PendingKey): PendingKeyAction {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
    return { kind: "pass" };
  }

  if (event.key === "Escape") {
    return { kind: "close" };
  }

  if (event.key === "Backspace") {
    return { buffer: Array.from(buffer).slice(0, -1).join(""), kind: "buffer" };
  }

  if (event.key === "Enter") {
    return { kind: "swallow" };
  }

  if (Array.from(event.key).length === 1) {
    return { buffer: `${buffer}${event.key}`, kind: "buffer" };
  }

  return { kind: "pass" };
}

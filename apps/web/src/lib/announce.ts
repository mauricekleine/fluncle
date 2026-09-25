import { useSyncExternalStore } from "react";

let wanted = false;
let markReady: (() => void) | undefined;
let ready: Promise<void> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function requestToaster(): Promise<void> {
  if (!ready) {
    ready = new Promise((resolve) => {
      markReady = resolve;
    });
    wanted = true;

    for (const listener of listeners) {
      listener();
    }
  }

  return ready;
}

export function toasterReady(): void {
  markReady?.();
}

export function useToasterWanted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => wanted,
    () => false,
  );
}

export function announce(message: string): void {
  void Promise.all([requestToaster(), import("sonner")]).then(([, { toast }]) => {
    toast(message);
  });
}

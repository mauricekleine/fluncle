export const env: Record<string, string | undefined> = {};
const waitUntilPromises: Promise<unknown>[] = [];

export function waitUntil(promise: Promise<unknown>): void {
  waitUntilPromises.push(promise);
  void promise;
}

export function takeWaitUntilPromises(): Promise<unknown>[] {
  return waitUntilPromises.splice(0);
}

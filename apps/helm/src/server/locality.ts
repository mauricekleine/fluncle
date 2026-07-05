// Request locality — the daemon's fetch layer marks each request it verified as
// arriving over the LOOPBACK (by remote address, never headers); feature routes
// read the mark to scope localhost-only affordances (test hooks, forced clocks)
// tighter than LAN auth. Nothing but the daemon can set the mark, so a header
// can never forge it.

const localRequests = new WeakSet<Request>();

/** Mark one request as verified-loopback. Called by the daemon's fetch gate only. */
export function markRequestLocal(req: Request): void {
  localRequests.add(req);
}

/** Did the daemon verify this request as loopback? Unmarked reads as remote. */
export function requestIsLocal(req: Request): boolean {
  return localRequests.has(req);
}

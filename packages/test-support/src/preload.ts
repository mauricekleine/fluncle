// The `bun test` end of the no-network rail (see ./no-network.ts for why it exists).
//
// Wired per package through a `bunfig.toml`:
//
//   [test]
//   preload = ["@fluncle/test-support/preload"]
//
// `[test] preload` runs ONLY under `bun test` — a `bun run` of the same code is
// untouched, so this can never alter how anything behaves in production. Vitest has no
// bunfig, so `apps/web` arms the same rail through its `setupFiles` instead.
//
// Installed at import time and never uninstalled: a bun preload has no afterAll to hang
// the restore on, and the process exists only to run tests.

import { installNoNetworkRail } from "./no-network";

installNoNetworkRail();

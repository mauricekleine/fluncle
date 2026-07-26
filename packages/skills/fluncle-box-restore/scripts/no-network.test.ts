import { assertRailArmed } from "@fluncle/test-support/no-network";

// Proof that this suite's `bun test` run has the shared no-network rail armed — wired by
// ./bunfig.toml's `[test] preload`. If this file goes red, the rail is down and the suite can
// reach the live backup bucket (see packages/test-support/src/no-network.ts).

assertRailArmed("the box-restore preflight");

import { mock } from "bun:test";

void mock.module("@raycast/api", () => ({
  getPreferenceValues: () => ({ flunclePath: "/usr/bin/fluncle" }),
}));

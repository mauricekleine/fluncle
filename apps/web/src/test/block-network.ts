import { installNoNetworkRail } from "@fluncle/test-support/no-network";
import { afterAll, beforeAll } from "vitest";

let restore: () => void = () => {};

beforeAll(() => {
  restore = installNoNetworkRail();
});

afterAll(() => {
  restore();
});

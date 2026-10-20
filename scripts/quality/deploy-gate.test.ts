import { describe, expect, test } from "bun:test";
import { DEPLOY_GATE_STEPS, runDeployGate } from "./deploy-gate.mjs";

describe("deploy gate", () => {
  test("a failing step does not stop later steps, and the gate fails with every failure named", () => {
    const steps = [
      { args: [], name: "first", program: "fake" },
      { args: [], name: "second", program: "fake" },
      { args: [], name: "third", program: "fake" },
    ];
    const ran: string[] = [];
    let output = "";
    const status = runDeployGate(
      steps,
      (step: { name: string }) => {
        ran.push(step.name);
        return step.name === "second" ? 0 : 2;
      },
      (text: string) => {
        output += text;
      },
    );
    expect(ran).toEqual(["first", "second", "third"]);
    expect(status).toBe(1);
    expect(output).toContain("2 of 3 steps failed: first (exit 2), third (exit 2)");
  });

  test("the gate passes only when every step passes", () => {
    expect(
      runDeployGate(
        DEPLOY_GATE_STEPS,
        () => 0,
        () => {},
      ),
    ).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  encodeDueWorkOrder,
  type DueWorkDirection,
  type DueWorkNullPlacement,
  type DueWorkOrderComponent,
} from "./due-work-order";

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function compareIntegers(left: bigint | number, right: bigint | number): number {
  const leftBigInt = typeof left === "bigint" ? left : BigInt(left);
  const rightBigInt = typeof right === "bigint" ? right : BigInt(right);
  return leftBigInt < rightBigInt ? -1 : leftBigInt > rightBigInt ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  if (Object.is(left, right)) {
    return 0;
  }
  if (Object.is(left, -0)) {
    return right < 0 ? 1 : -1;
  }
  if (Object.is(right, -0)) {
    return left < 0 ? -1 : 1;
  }
  return left < right ? -1 : 1;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return (leftBytes[index] ?? 0) < (rightBytes[index] ?? 0) ? -1 : 1;
    }
  }
  return sign(leftBytes.length - rightBytes.length);
}

function compareNullableTimestamps(
  left: string | null,
  right: string | null,
  nulls: DueWorkNullPlacement,
): number {
  if (left === null || right === null) {
    if (left === right) {
      return 0;
    }
    const nullResult = left === null ? -1 : 1;
    return nulls === "first" ? nullResult : -nullResult;
  }
  const leftMilliseconds = Date.parse(left);
  const rightMilliseconds = Date.parse(right);
  return sign(leftMilliseconds - rightMilliseconds);
}

function compareComponentValues(left: DueWorkOrderComponent, right: DueWorkOrderComponent): number {
  if (left.kind !== right.kind) {
    throw new Error("This property helper compares one tuple position at a time");
  }
  let result: number;
  switch (left.kind) {
    case "integer":
      if (right.kind !== "integer") {
        throw new Error("Mismatched test component kinds");
      }
      result = compareIntegers(left.value, right.value);
      break;
    case "number":
      if (right.kind !== "number") {
        throw new Error("Mismatched test component kinds");
      }
      result = compareNumbers(left.value, right.value);
      break;
    case "text":
      if (right.kind !== "text") {
        throw new Error("Mismatched test component kinds");
      }
      result = compareUtf8(left.value, right.value);
      break;
    case "timestamp":
      if (right.kind !== "timestamp") {
        throw new Error("Mismatched test component kinds");
      }
      result = compareNullableTimestamps(left.value, right.value, left.nulls);
      if (left.value === null || right.value === null) {
        return result;
      }
      break;
    case "boolean":
      if (right.kind !== "boolean") {
        throw new Error("Mismatched test component kinds");
      }
      result = left.value === right.value ? 0 : left.value ? 1 : -1;
      break;
    default:
      throw new Error("Unsupported test component kind");
  }
  return left.direction === "asc" ? result : -result;
}

function compareTuples(
  left: readonly DueWorkOrderComponent[],
  right: readonly DueWorkOrderComponent[],
): number {
  if (left.length !== right.length) {
    throw new Error("This property helper compares equal-width tuples");
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index];
    const rightComponent = right[index];
    if (leftComponent === undefined || rightComponent === undefined) {
      throw new Error("Test tuple unexpectedly lost a component");
    }
    const result = compareComponentValues(leftComponent, rightComponent);
    if (result !== 0) {
      return result;
    }
  }
  return 0;
}

function component<T extends DueWorkOrderComponent["kind"]>(
  kind: T,
  value: Extract<DueWorkOrderComponent, { kind: T }>["value"],
  direction: DueWorkDirection,
): Extract<DueWorkOrderComponent, { kind: T }> {
  return { direction, kind, value } as Extract<DueWorkOrderComponent, { kind: T }>;
}

function timestamp(
  value: string | null,
  direction: DueWorkDirection,
  nulls: DueWorkNullPlacement,
): Extract<DueWorkOrderComponent, { kind: "timestamp" }> {
  return { direction, kind: "timestamp", nulls, value };
}

function assertPairwiseOrder(
  values: readonly DueWorkOrderComponent[],
  compare: (left: DueWorkOrderComponent, right: DueWorkOrderComponent) => number,
): void {
  const keys = values.map((value) => encodeDueWorkOrder([value]));
  for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < values.length; rightIndex += 1) {
      const direct = sign(
        compare(
          values[leftIndex] as DueWorkOrderComponent,
          values[rightIndex] as DueWorkOrderComponent,
        ),
      );
      const encoded = binaryCompare(keys[leftIndex] ?? "", keys[rightIndex] ?? "");
      expect(encoded, `pair ${leftIndex},${rightIndex}`).toBe(direct);
    }
  }
}

describe("encodeDueWorkOrder", () => {
  it("keeps signed safe integers and arbitrary BigInts in exact ASC and DESC order", () => {
    const values: Array<bigint | number> = [
      -((1n << 256n) + 17n),
      -((1n << 64n) + 1n),
      -256n,
      -2,
      -1n,
      0,
      1n,
      2,
      255n,
      256n,
      (1n << 64n) + 1n,
      (1n << 256n) + 17n,
    ];
    for (const direction of ["asc", "desc"] as const) {
      const components = values.map((value) => component("integer", value, direction));
      assertPairwiseOrder(components, (left, right) => compareComponentValues(left, right));
    }
  });

  it("matches the IEEE-754 total order for finite numbers, including both zeros", () => {
    const values = [
      -Number.MAX_VALUE,
      -1.5,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1.5,
      Number.MAX_VALUE,
    ];
    for (const direction of ["asc", "desc"] as const) {
      const components = values.map((value) => component("number", value, direction));
      assertPairwiseOrder(components, (left, right) => compareComponentValues(left, right));
    }
  });

  it("uses UTF-8 byte order and keeps prefixes in the right place for ASC and DESC", () => {
    const values = ["", "a", "aa", "a\u0000", "a\u0000b", "a\uffff", "é", "🦄"];
    for (const direction of ["asc", "desc"] as const) {
      const components = values.map((value) => component("text", value, direction));
      assertPairwiseOrder(components, (left, right) => compareComponentValues(left, right));
    }
  });

  it("keeps explicit timestamp null placement independent from direction", () => {
    const values = [
      null,
      "1969-12-31T23:59:59.999Z",
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T01:00:00.000+01:00",
      "2030-06-15T12:30:45.123-04:00",
    ];
    for (const direction of ["asc", "desc"] as const) {
      for (const nulls of ["first", "last"] as const) {
        const components = values.map((value) => timestamp(value, direction, nulls));
        assertPairwiseOrder(components, (left, right) => compareComponentValues(left, right));
      }
    }
  });

  it("orders booleans and gives tuple precedence to earlier components", () => {
    for (const direction of ["asc", "desc"] as const) {
      const booleanValues = [false, true].map((value) => component("boolean", value, direction));
      assertPairwiseOrder(booleanValues, (left, right) => compareComponentValues(left, right));
    }

    const tuples: Array<readonly DueWorkOrderComponent[]> = [
      [
        component("integer", 1, "asc"),
        component("text", "z", "asc"),
        component("boolean", false, "asc"),
      ],
      [
        component("integer", 1, "asc"),
        component("text", "z", "asc"),
        component("boolean", true, "asc"),
      ],
      [
        component("integer", 1, "asc"),
        component("text", "za", "asc"),
        component("boolean", false, "asc"),
      ],
      [
        component("integer", 2, "asc"),
        component("text", "", "asc"),
        component("boolean", false, "asc"),
      ],
      [
        component("integer", 3, "asc"),
        component("text", "", "asc"),
        component("boolean", false, "asc"),
      ],
    ];
    const keys = tuples.map((tuple) => encodeDueWorkOrder(tuple));
    for (let leftIndex = 0; leftIndex < tuples.length; leftIndex += 1) {
      for (let rightIndex = 0; rightIndex < tuples.length; rightIndex += 1) {
        const direct = sign(compareTuples(tuples[leftIndex] ?? [], tuples[rightIndex] ?? []));
        expect(
          binaryCompare(keys[leftIndex] ?? "", keys[rightIndex] ?? ""),
          `pair ${leftIndex},${rightIndex}`,
        ).toBe(direct);
      }
    }
    expect(binaryCompare(keys[0] ?? "", keys[1] ?? "")).toBe(-1);
    expect(binaryCompare(keys[1] ?? "", keys[2] ?? "")).toBe(-1);
    expect(binaryCompare(keys[2] ?? "", keys[3] ?? "")).toBe(-1);
  });

  it("is collision-free across component boundaries and supported representations", () => {
    const tuples: Array<readonly DueWorkOrderComponent[]> = [
      [component("text", "", "asc"), component("boolean", false, "asc")],
      [component("text", "a", "asc"), component("boolean", false, "asc")],
      [component("text", "a\u0000", "asc"), component("boolean", false, "asc")],
      [component("text", "a", "desc"), component("boolean", false, "asc")],
      [component("integer", -1, "asc")],
      [component("integer", 1n, "asc")],
      [component("number", -0, "asc")],
      [component("number", 0, "asc")],
      [timestamp(null, "asc", "first")],
      [timestamp(null, "asc", "last")],
      [timestamp("2024-01-01T00:00:00.000Z", "asc", "first")],
      [timestamp("2023-12-31T18:59:59.999-05:00", "asc", "first")],
    ];
    const keys = tuples.map((tuple) => encodeDueWorkOrder(tuple));
    expect(keys.every((key) => /^[0-9a-f]+$/.test(key))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rejects invalid numeric, Unicode, and timestamp inputs", () => {
    expect(() =>
      encodeDueWorkOrder([component("integer", Number.MAX_SAFE_INTEGER + 1, "asc")]),
    ).toThrow(/safe integers/);
    expect(() => encodeDueWorkOrder([component("number", Number.NaN, "asc")])).toThrow(/finite/);
    expect(() =>
      encodeDueWorkOrder([component("number", Number.POSITIVE_INFINITY, "asc")]),
    ).toThrow(/finite/);
    expect(() => encodeDueWorkOrder([component("text", "\ud800", "asc")])).toThrow(/Unicode/);
    expect(() =>
      encodeDueWorkOrder([timestamp("2024-02-30T00:00:00.000Z", "asc", "first")]),
    ).toThrow(/ISO timestamp/);
    expect(() => encodeDueWorkOrder([timestamp("2024-01-01", "asc", "first")])).toThrow(
      /ISO timestamp/,
    );
  });
});

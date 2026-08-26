/** The two directions understood by a due-work order component. */
export type DueWorkDirection = "asc" | "desc";

/** Explicit placement for a nullable timestamp component. */
export type DueWorkNullPlacement = "first" | "last";

/** One position in a due-work tuple. Every position carries its own ordering rules. */
export type DueWorkOrderComponent =
  | {
      kind: "integer";
      value: bigint | number;
      direction: DueWorkDirection;
    }
  | {
      kind: "number";
      value: number;
      direction: DueWorkDirection;
    }
  | {
      kind: "text";
      value: string;
      direction: DueWorkDirection;
    }
  | {
      kind: "timestamp";
      value: string | null;
      direction: DueWorkDirection;
      nulls: DueWorkNullPlacement;
    }
  | {
      kind: "boolean";
      value: boolean;
      direction: DueWorkDirection;
    };

type Bytes = number[];

const BYTE_MASK = 0xffn;
const FLOAT_SIGN_BIT = 0x8000000000000000n;
const UINT64_MASK = 0xffffffffffffffffn;
const SIGNED_INTEGER_BIAS = 0x8000000000000000n;
const UTF8 = new TextEncoder();

// Tags are part of the format, rather than metadata outside the key. This makes different
// component kinds and different order descriptions unable to serialize to the same bytes.
const TAGS = {
  boolean: { asc: 0x40, desc: 0x41 },
  integer: { asc: 0x10, desc: 0x11 },
  number: { asc: 0x20, desc: 0x21 },
  text: { asc: 0x30, desc: 0x31 },
  timestamp: {
    first: { asc: 0x50, desc: 0x51 },
    last: { asc: 0x52, desc: 0x53 },
  },
} as const;

function isDirection(value: unknown): value is DueWorkDirection {
  return value === "asc" || value === "desc";
}

function isNullPlacement(value: unknown): value is DueWorkNullPlacement {
  return value === "first" || value === "last";
}

function invert(bytes: Bytes): Bytes {
  return bytes.map((byte) => 0xff - byte);
}

function fixedWidthBytes(value: bigint, width: number): Bytes {
  if (value < 0n || value >= 1n << BigInt(width * 8)) {
    throw new RangeError("Value does not fit the requested fixed width");
  }

  const bytes = Array.from({ length: width }, () => 0);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & BYTE_MASK);
    remaining >>= 8n;
  }
  return bytes;
}

function minimalBigIntBytes(value: bigint): Bytes {
  if (value === 0n) {
    return [];
  }

  const hex = value.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes: Bytes = [];
  for (let index = 0; index < padded.length; index += 2) {
    bytes.push(Number.parseInt(padded.slice(index, index + 2), 16));
  }
  return bytes;
}

function integerPayload(value: bigint | number, direction: DueWorkDirection): Bytes {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError("Integer components require safe integers or BigInt values");
  }
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError("Integer components require a number or BigInt value");
  }

  const integer = typeof value === "bigint" ? value : BigInt(value);
  if (integer === 0n) {
    return direction === "asc" ? [0x20] : [0xdf];
  }

  const negative = integer < 0n;
  const magnitude = negative ? -integer : integer;
  const magnitudeBytes = minimalBigIntBytes(magnitude);

  // Positive lengths use 01…01 00, so larger magnitudes sort later. Negative lengths use
  // 00…00 01, so a larger magnitude (and therefore a smaller number) sorts earlier. The
  // length terminator makes the variable-width payload self-delimiting before its fixed-size
  // magnitude bytes begin.
  const lengthPrefix = Array.from({ length: magnitudeBytes.length }, () =>
    negative ? 0x00 : 0x01,
  );
  lengthPrefix.push(negative ? 0x01 : 0x00);
  const magnitudePayload = negative ? invert(magnitudeBytes) : magnitudeBytes;
  const payload = [negative ? 0x10 : 0x30, ...lengthPrefix, ...magnitudePayload];
  return direction === "asc" ? payload : invert(payload);
}

function numberPayload(value: number, direction: DueWorkDirection): Bytes {
  if (!Number.isFinite(value)) {
    throw new RangeError("Number components require finite IEEE-754 values");
  }

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  // This is the standard monotonic transform from IEEE-754 bit patterns to unsigned order.
  // It deliberately gives -0 a position immediately before +0, making every finite bit
  // pattern distinct and deterministic.
  const ordered = (bits & FLOAT_SIGN_BIT) !== 0n ? ~bits & UINT64_MASK : bits ^ FLOAT_SIGN_BIT;
  const payload = fixedWidthBytes(ordered, 8);
  return direction === "asc" ? payload : invert(payload);
}

function assertValidUtf16(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextIndex = index + 1;
      if (nextIndex >= value.length) {
        throw new TypeError("Text components must contain valid Unicode scalar values");
      }
      const nextCodeUnit = value.charCodeAt(nextIndex);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new TypeError("Text components must contain valid Unicode scalar values");
      }
      index = nextIndex;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Text components must contain valid Unicode scalar values");
    }
  }
}

function textPayload(value: string, direction: DueWorkDirection): Bytes {
  assertValidUtf16(value);
  const payload: Bytes = [];
  for (const byte of UTF8.encode(value)) {
    // Each UTF-8 byte becomes two non-zero bytes. Zero is reserved as the terminator, so a
    // shorter text sorts before a longer text with the shorter value as its prefix.
    payload.push((byte >> 4) + 1, (byte & 0x0f) + 1);
  }
  payload.push(0x00);
  return direction === "asc" ? payload : invert(payload);
}

function parseIsoTimestamp(value: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (match === null) {
    throw new RangeError("Timestamp components require an ISO timestamp with an explicit offset");
  }

  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  const hourText = match[4];
  const minuteText = match[5];
  const secondText = match[6];
  const fractionText = match[7];
  const offsetText = match[8];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined ||
    offsetText === undefined
  ) {
    throw new RangeError("Invalid ISO timestamp");
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new RangeError("Invalid ISO timestamp");
  }

  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw new RangeError("Invalid ISO timestamp offset");
    }
  }

  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError("Invalid ISO timestamp");
  }
  // Date.parse truncates precision beyond milliseconds. The grammar rejects that precision so
  // two different supported instants can never silently collapse onto one timestamp key.
  if (fractionText !== undefined && fractionText.length > 3) {
    throw new RangeError("Timestamp fractions may contain at most three digits");
  }
  return milliseconds;
}

function timestampPayload(
  value: string | null,
  direction: DueWorkDirection,
  nulls: DueWorkNullPlacement,
): Bytes {
  const nullMarker = nulls === "first" ? 0x00 : 0xff;
  const valueMarker = nulls === "first" ? 0x01 : 0x00;
  if (value === null) {
    return [nullMarker];
  }

  const milliseconds = parseIsoTimestamp(value);
  const ordered = fixedWidthBytes(BigInt(milliseconds) + SIGNED_INTEGER_BIAS, 8);
  const valueBytes = direction === "asc" ? ordered : invert(ordered);
  return [valueMarker, ...valueBytes];
}

function componentBytes(component: DueWorkOrderComponent): Bytes {
  switch (component.kind) {
    case "integer": {
      if (!isDirection(component.direction)) {
        throw new TypeError("Integer components require asc or desc direction");
      }
      return [
        TAGS.integer[component.direction],
        ...integerPayload(component.value, component.direction),
      ];
    }
    case "number": {
      if (!isDirection(component.direction)) {
        throw new TypeError("Number components require asc or desc direction");
      }
      return [
        TAGS.number[component.direction],
        ...numberPayload(component.value, component.direction),
      ];
    }
    case "text": {
      if (!isDirection(component.direction)) {
        throw new TypeError("Text components require asc or desc direction");
      }
      return [TAGS.text[component.direction], ...textPayload(component.value, component.direction)];
    }
    case "timestamp": {
      if (!isDirection(component.direction) || !isNullPlacement(component.nulls)) {
        throw new TypeError("Timestamp components require direction and null placement");
      }
      return [
        TAGS.timestamp[component.nulls][component.direction],
        ...timestampPayload(component.value, component.direction, component.nulls),
      ];
    }
    case "boolean": {
      if (!isDirection(component.direction)) {
        throw new TypeError("Boolean components require asc or desc direction");
      }
      const payload = component.value ? [0x01] : [0x00];
      return [
        TAGS.boolean[component.direction],
        ...(component.direction === "asc" ? payload : invert(payload)),
      ];
    }
    default:
      throw new TypeError("Unsupported due-work component kind");
  }
}

function bytesToLowerHex(bytes: Bytes): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Encode a due-work tuple as one lowercase hexadecimal TEXT key.
 *
 * Every fixed-width component has a known byte width. Text is UTF-8 encoded with a reserved
 * terminator, and integer magnitudes use a terminated unary length prefix. Therefore concatenated
 * components remain unambiguous, while lowercase hexadecimal preserves bytewise BINARY order in
 * SQLite exactly.
 */
export function encodeDueWorkOrder(components: readonly DueWorkOrderComponent[]): string {
  if (!Array.isArray(components)) {
    throw new TypeError("Due-work order must be an array of components");
  }

  const bytes: Bytes = [];
  for (const component of components) {
    if (typeof component !== "object" || component === null) {
      throw new TypeError("Due-work components must be objects");
    }
    bytes.push(...componentBytes(component));
  }
  return bytesToLowerHex(bytes);
}

import { Cause, Logger, type LogLevel, References } from "effect";

type ConsoleLevel = "error" | "info" | "warn";

function consoleLevel(level: LogLevel.LogLevel): ConsoleLevel {
  if (level === "Error" || level === "Fatal") {
    return "error";
  }

  return level === "Warn" ? "warn" : "info";
}

function fieldValue(value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}

export const serverLogger = Logger.make(({ cause, fiber, logLevel, message }) => {
  const parts: unknown[] = Array.isArray(message) ? message : [message];
  const payload: Record<string, unknown> = { event: parts.map(String).join(" ") };

  for (const [key, value] of Object.entries(fiber.getRef(References.CurrentLogAnnotations))) {
    payload[key] = fieldValue(value);
  }

  if (cause.reasons.length > 0) {
    payload.cause = Cause.pretty(cause);
  }

  console[consoleLevel(logLevel)](JSON.stringify(payload));
});

export const serverLoggerLayer = Logger.layer([serverLogger]);

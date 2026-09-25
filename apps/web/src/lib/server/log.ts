type LogLevel = "error" | "info" | "warn";

export function logEvent(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const payload: Record<string, unknown> = { event };

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      payload[key] =
        value instanceof Error ? { message: value.message, stack: value.stack } : value;
    }
  }

  console[level](JSON.stringify(payload));
}

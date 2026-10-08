import { parse } from "dotenv";

export function dotenvLine(key: string, value: string): string {
  for (const quote of ["'", "`", '"']) {
    const encoded = quote === '"' ? value.replace(/\r/g, "\\r").replace(/\n/g, "\\n") : value;
    const line = `${key}=${quote}${encoded}${quote}`;

    if (parse(line)[key] === value) {
      return line;
    }
  }

  throw new Error(`Cannot encode ${key} in a dotenv file; use process-only secrets instead.`);
}

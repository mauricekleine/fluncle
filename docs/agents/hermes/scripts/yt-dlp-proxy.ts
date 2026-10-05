import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function withYtDlpProxyConfig<T>(proxyUrl: string, call: (argvPrefix: string[]) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "fluncle-yt-dlp-proxy-"));
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, "proxy.conf");
    const quotedUrl = `'${proxyUrl.replaceAll("'", "'\\''")}'`;
    writeFileSync(path, `--proxy ${quotedUrl}\n`, { flag: "wx", mode: 0o600 });
    return call(["--config-locations", path]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function scrubProxyUserinfo(text: string): string {
  return text.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, "$1[redacted]@");
}

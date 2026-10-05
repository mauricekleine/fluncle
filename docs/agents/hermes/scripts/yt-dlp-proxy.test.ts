import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { scrubProxyUserinfo, withYtDlpProxyConfig } from "./yt-dlp-proxy";

test("yt-dlp proxy credentials stay in a private config through the call and are removed afterward", () => {
  const proxyUrl = "http://user:secret@proxy.example:8080";
  let directory = "";
  const result = withYtDlpProxyConfig(proxyUrl, (argvPrefix) => {
    expect(argvPrefix[0]).toBe("--config-locations");
    expect(argvPrefix).not.toContain("--proxy");
    expect(argvPrefix.join(" ")).not.toContain("secret");
    const path = argvPrefix[1];
    if (!path) {
      throw new Error("proxy config path is missing");
    }
    directory = dirname(path);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(`--proxy '${proxyUrl}'\n`);
    return "complete";
  });
  expect(result).toBe("complete");
  expect(existsSync(directory)).toBe(false);
});

test("yt-dlp proxy configs escape apostrophes and are removed when the call throws", () => {
  let directory = "";
  expect(() =>
    withYtDlpProxyConfig("http://user:sec'ret@proxy.example:8080", (argvPrefix) => {
      const path = argvPrefix[1];
      if (!path) {
        throw new Error("proxy config path is missing");
      }
      directory = dirname(path);
      expect(readFileSync(path, "utf8")).toBe(
        "--proxy 'http://user:sec'\\''ret@proxy.example:8080'\n",
      );
      throw new Error("provider timed out");
    }),
  ).toThrow("provider timed out");
  expect(existsSync(directory)).toBe(false);
});

test("proxy userinfo is scrubbed while provider status and ordinary URLs remain visible", () => {
  expect(
    scrubProxyUserinfo(
      "http://user:secret@proxy.example https://user:p%40ss@proxy.example socks5://user:secret@proxy.example 407 TRAFFIC_EXHAUSTED https://proxy.example/path",
    ),
  ).toBe(
    "http://[redacted]@proxy.example https://[redacted]@proxy.example socks5://[redacted]@proxy.example 407 TRAFFIC_EXHAUSTED https://proxy.example/path",
  );
});

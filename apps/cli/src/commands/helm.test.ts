import { describe, expect, test } from "bun:test";

import { buildLaunchAgentPlist } from "./helm";

describe("buildLaunchAgentPlist", () => {
  const plist = buildLaunchAgentPlist(
    "/Users/op/fluncle/apps/helm",
    "/opt/homebrew/bin/bun",
    "/Users/op/Library/Logs/fluncle-helm.log",
  );

  test("carries the label, RunAtLoad, and the daemon invocation", () => {
    expect(plist).toContain("<string>com.fluncle.helm</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(plist).toContain("<string>src/server.ts</string>");
    expect(plist).toContain("<string>/Users/op/fluncle/apps/helm</string>");
  });

  test("logs both streams to the helm log", () => {
    const occurrences = plist.split("/Users/op/Library/Logs/fluncle-helm.log").length - 1;

    expect(occurrences).toBe(2);
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
  });

  test("restarts on a crash but not on a clean exit", () => {
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
  });

  test("gives launchd a PATH that can find bun and sysctl", () => {
    expect(plist).toContain("/opt/homebrew/bin:");
    expect(plist).toContain("/usr/sbin");
  });

  test("XML-escapes hostile path characters", () => {
    const escaped = buildLaunchAgentPlist('/tmp/a"b&c', "/usr/local/bin/bun", "/tmp/log");

    expect(escaped).toContain("/tmp/a&quot;b&amp;c");
    expect(escaped).not.toContain('a"b&c');
  });
});

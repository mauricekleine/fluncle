// macOS notifications, server-side — `notify(title, body)` via osascript, exposed
// to features through the HelmContext so a long run can tap the operator on the
// shoulder even when no window is open (the launchd daemon is windowless).

/** Quote text as an AppleScript string literal (backslashes, then quotes). */
export function asAppleScriptString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export async function notify(title: string, body: string): Promise<void> {
  const script = `display notification ${asAppleScriptString(body)} with title ${asAppleScriptString(title)}`;
  const proc = Bun.spawn(["/usr/bin/osascript", "-e", script], {
    stderr: "pipe",
    stdin: "ignore",
    stdout: "ignore",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`osascript refused the notification: ${stderr.trim() || `exit ${exitCode}`}`);
  }
}

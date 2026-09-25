import { CliError } from "./output";

export async function openExternal(target: string): Promise<void> {
  const command = platformOpenCommand();

  if (!command) {
    console.log(target);
    throw new CliError(
      "unsupported_platform",
      `Automatic opening is only supported on macOS and Linux. Open this manually: ${target}`,
    );
  }

  const child = Bun.spawn([command, target], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new CliError("open_failed", stderr.trim() || `Could not open ${target} with ${command}`);
  }
}

function platformOpenCommand(): string | undefined {
  if (process.platform === "darwin") {
    return "open";
  }

  if (process.platform === "linux") {
    return "xdg-open";
  }

  return undefined;
}

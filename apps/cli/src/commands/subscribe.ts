import { createInterface } from "node:readline/promises";
import { publicApiPost } from "../api";
import { CliError, printJson } from "../output";

type SubscribeResponse = {
  ok: true;
};

export async function subscribeCommand(email?: string, json?: boolean): Promise<void> {
  const address = email?.trim() || (await promptLine("Email: "));

  if (!address) {
    throw new CliError("invalid_email", "Enter a valid email address.");
  }

  await publicApiPost<SubscribeResponse>("/api/newsletter", {
    email: address,
  });

  if (json) {
    printJson({
      ok: true,
    });
    return;
  }

  console.log("You're on the list.");
}

async function promptLine(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "not_interactive",
      "fluncle subscribe requires an email argument or an interactive terminal.",
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

import { publicApiPost } from "../api";
import { promptLine } from "../interactive";
import { CliError, printJson } from "../output";

type SubscribeResponse = {
  ok: true;
};

const PROMPT_NON_INTERACTIVE_MESSAGE =
  "fluncle subscribe requires an email argument or an interactive terminal.";

export async function subscribeCommand(email?: string, json?: boolean): Promise<void> {
  const address = email?.trim() || (await promptLine("Email: ", PROMPT_NON_INTERACTIVE_MESSAGE));

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

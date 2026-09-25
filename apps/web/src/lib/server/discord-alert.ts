import { readOptionalEnv } from "./env";

type SignupAlert = {
  crewNumber?: number;
};

export async function notifyDiscordSignup({ crewNumber }: SignupAlert): Promise<void> {
  const configuredUrl = await readOptionalEnv("DISCORD_ALERT_WEBHOOK");

  if (!configuredUrl) {
    return;
  }

  const webhookUrl = new URL(configuredUrl);
  webhookUrl.searchParams.set("wait", "true");

  const suffix = crewNumber == null ? "" : ` — crew #${crewNumber}`;
  const response = await fetch(webhookUrl, {
    body: JSON.stringify({
      allowed_mentions: {
        parse: [],
      },
      content: `New crew member signed up${suffix}.`,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const message = await response.text();

    throw new Error(`Discord signup alert failed: ${response.status} ${message}`);
  }
}

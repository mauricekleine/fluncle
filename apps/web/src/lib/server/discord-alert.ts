import { Data, Duration, Effect } from "effect";
import { readOptionalEnv } from "./env";
import { runServerEffect } from "./effect/runtime";

class DiscordDeliveryFailed extends Data.TaggedError("DiscordDeliveryFailed")<{
  cause: unknown;
}> {}

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
  return runServerEffect(
    Effect.tryPromise({
      catch: (cause) => new DiscordDeliveryFailed({ cause }),
      try: async (signal) => {
        const response = await fetch(webhookUrl, {
          body: JSON.stringify({
            allowed_mentions: { parse: [] },
            content: `New crew member signed up${suffix}.`,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal,
        });
        if (!response.ok) {
          const message = await response.text();
          throw new Error(`Discord signup alert failed: ${response.status} ${message}`);
        }
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(15),
        orElse: () =>
          Effect.fail(
            new DiscordDeliveryFailed({
              cause: new Error("Discord signup alert failed: request timed out"),
            }),
          ),
      }),
      Effect.catchTag("DiscordDeliveryFailed", (error) => Effect.fail(error.cause)),
    ),
  );
}

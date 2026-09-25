import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ChatConversation } from "@/components/chat/chat-conversation";
import { GateNotice } from "@/components/gate-notice";
import { siteUrl } from "@/lib/fluncle-links";
import { createCsrfToken, getPublicSession } from "@/lib/server/public-auth";
import { Button } from "@fluncle/ui/components/button";

type ChatGate = { state: "anonymous" | "unverified" } | { csrfToken: string; state: "verified" };

const getChatGate = createServerFn({ method: "GET" }).handler(async (): Promise<ChatGate> => {
  const user = await getPublicSession(getRequest());

  if (!user) {
    return { state: "anonymous" };
  }

  if (!user.emailVerified) {
    return { state: "unverified" };
  }

  return { csrfToken: createCsrfToken(user), state: "verified" };
});

// oxlint-disable-next-line sort-keys -- TanStack's canonical option order (loader feeds head/component).
export const Route = createFileRoute("/chat")({
  loader: () => getChatGate(),

  staleTime: 0,
  head: () => ({
    links: [{ href: `${siteUrl}/chat`, rel: "canonical" }],
    meta: [
      { title: "ChatDnB" },
      {
        content: "Talk to Fluncle. He answers from his own archive of certified findings.",
        name: "description",
      },

      { content: "noindex", name: "robots" },
    ],
  }),
  component: ChatDoor,
});

function ChatDoor() {
  const gate = Route.useLoaderData();

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden p-4 text-foreground sm:p-6 lg:px-8 lg:py-6">
      <article className="home-plate chat-plate mx-auto min-h-0 w-full max-w-4xl flex-1">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">ChatDnB</h1>
            <p className="home-tagline">Ask Fluncle. He answers from the archive or not at all.</p>
          </div>
        </header>

        {gate.state === "verified" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatConversation
              csrfToken={gate.csrfToken}
              emptyState="Ask for a mood, an artist, or a coordinate off one of my log pages. I answer from the archive, or I say I haven't been there yet."
              transportApi="/api/chat"
            />
          </div>
        ) : gate.state === "unverified" ? (
          <GateNotice
            action={
              <Button
                nativeButton={false}
                render={<Link search={{ tab: "settings" }} to="/account" />}
                variant="outline"
              >
                Open settings
              </Button>
            }
            body="The verification link is in your inbox. If it got lost between dimensions, you can resend it from settings."
            lede="Verify your email to open this door."
          />
        ) : (
          <GateNotice
            action={
              <Button nativeButton={false} render={<Link to="/account" />} variant="outline">
                Sign in
              </Button>
            }
            body="He answers from his own archive, one certified finding at a time."
            lede="Sign in to talk to Fluncle."
          />
        )}
      </article>
    </main>
  );
}

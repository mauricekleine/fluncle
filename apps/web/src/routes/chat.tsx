import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type ReactNode } from "react";
import { ChatConversation } from "@/components/chat/chat-conversation";
import { siteUrl } from "@/lib/fluncle-links";
import { createCsrfToken, getPublicSession } from "@/lib/server/public-auth";
import { Button } from "@fluncle/ui/components/button";

// ── /chat — ChatDnB, the crew door ────────────────────────────────────────────────────
//
// The public face of ChatDnB: a chat with Fluncle over his own archive, opened to the
// crew — verified-email accounts, the learning cohort of the gated rollout (sign-in never
// requires verification; FEATURES gate on it). The conversation itself is the SHARED
// ChatConversation (components/chat/), the same transcript the /admin/chat workbench
// renders; this route wraps it in the public chrome instead of the AdminShell, points the
// transport at the session-gated POST /api/chat, and hands it the CSRF token every
// message POST must carry.
//
// Not a SaaS chat window (PRODUCT.md bans the streaming-app clone by name): one quiet
// plate, dark, the conversation is the content. Three states off the session — anonymous
// (a quiet invitation to sign in), signed-in-but-unverified (the verify pointer), and
// verified (the chat). The gate here is WAYFINDING only: the server route re-checks the
// session, the verification, the origin/CSRF, and the rate dials on every turn.

/**
 * The gate state for the door, resolved from the requester's own session. Deliberately
 * minimal — no email, no name, nothing the page does not render. The CSRF token is
 * minted only for the verified state (the only one that can post a turn), the same
 * loader-minted token the account page uses for its mutations.
 */
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
  head: () => ({
    links: [{ href: `${siteUrl}/chat`, rel: "canonical" }],
    meta: [
      { title: "ChatDnB" },
      {
        content: "Talk to Fluncle. He answers from his own archive of certified findings.",
        name: "description",
      },
      // Unlisted while the rollout is gated (ROADMAP §ChatDnB): the door exists for the
      // crew who sign in, but it is not announced, not in the registry, and not indexed.
      // Delete this tag when ChatDnB graduates to a public surface.
      { content: "noindex", name: "robots" },
    ],
  }),
  component: ChatDoor,
});

function ChatDoor() {
  const gate = Route.useLoaderData();

  return (
    // The workbench register (public-chrome locks the shell to the viewport on /chat):
    // this main is a flex column filling everything under the top bar, the plate fills
    // the main, and the transcript scrolls INSIDE the plate — the ChatGPT shape, worn
    // as a Fluncle plate. min-h-0 at every level or the scroller can't shrink.
    <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden p-4 text-foreground sm:p-6 lg:px-8 lg:py-6">
      <article className="home-plate chat-plate mx-auto min-h-0 w-full max-w-4xl flex-1">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">ChatDnB</h1>
            <p className="home-tagline">Ask Fluncle. He answers from the archive or not at all.</p>
          </div>
        </header>

        {gate.state === "verified" ? (
          // The transcript takes every row the plate has left under the masthead.
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

/**
 * The quiet gate notice: a lede, one line of context, and the single literal control that
 * opens the way (the Chrome Rule: the prose carries the voice, the button names the
 * action). An outline control, never a gold fill — One Sun.
 */
function GateNotice({ action, body, lede }: { action: ReactNode; body: string; lede: string }) {
  return (
    <div className="flex flex-col items-start gap-4 py-10">
      <div className="space-y-1.5">
        <p className="text-base text-foreground">{lede}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}

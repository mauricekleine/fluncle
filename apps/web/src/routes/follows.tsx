import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { siteUrl } from "@/lib/fluncle-links";

type FollowsSearch = { token?: string; unsubscribe?: string };

type DigestFollow = { id: string; kind: "artist" | "label"; name: string; slug: string };

type FollowsPageData =
  | { mode: "invalid" }
  | { mode: "unsubscribe"; token: string }
  | { follows: DigestFollow[]; mode: "manage"; subscribed: boolean; token: string };

const loadFollowsPage = createServerFn({ method: "GET" })
  .validator((data: FollowsSearch) => data)
  .handler(async ({ data }): Promise<FollowsPageData> => {
    const { verifyFollowDigestToken } = await import("@/lib/server/follow-digest-tokens");

    if (data.token) {
      const userId = verifyFollowDigestToken(data.token, "manage");

      if (userId) {
        const { listDigestFollows } = await import("@/lib/server/follow-digest");
        const { follows, subscribed } = await listDigestFollows(userId);

        return { follows, mode: "manage", subscribed, token: data.token };
      }
    }

    if (data.unsubscribe && verifyFollowDigestToken(data.unsubscribe, "unsubscribe")) {
      return { mode: "unsubscribe", token: data.unsubscribe };
    }

    return { mode: "invalid" };
  });

function tokenParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length < 400 ? value : undefined;
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/follows")({
  validateSearch: (search: Record<string, unknown>): FollowsSearch => ({
    token: tokenParam(search.token),
    unsubscribe: tokenParam(search.unsubscribe),
  }),
  loaderDeps: ({ search }) => ({ token: search.token, unsubscribe: search.unsubscribe }),
  loader: ({ deps }) => loadFollowsPage({ data: deps }),
  staleTime: 0,
  head: () => ({
    links: [{ href: `${siteUrl}/follows`, rel: "canonical" }],
    meta: [
      { title: "Your follows email" },
      { content: "noindex, nofollow", name: "robots" },
      { content: "no-referrer", name: "referrer" },
    ],
  }),
  component: FollowsPage,
});

async function digestRequest(path: string, method: "DELETE" | "POST"): Promise<boolean> {
  try {
    const response = await fetch(path, {
      body: method === "POST" ? "{}" : undefined,
      headers: { "Content-Type": "application/json" },
      method,
    });

    return response.ok;
  } catch {
    return false;
  }
}

const COPY = {
  done: "Done, no more follows email. You still follow everyone, and you can switch it back on here or from your account.",
  emailHeading: "Follows email",
  emailOff: "Off. You still follow everyone below.",
  emailOn: "On. I send it on Fridays when there's something new, and skip the weeks there isn't.",
  failed: "I couldn't change that just now. Try again in a moment.",
  invalid:
    "That link doesn't work anymore. Sign in and you can change who you follow from your account.",
  prompt: "I'll stop sending your follows email. You keep following everyone.",
  start: "Start the follows email",
  stop: "Stop the follows email",
} as const;

function FollowsPage() {
  const data = Route.useLoaderData();

  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:p-8">
      <article className="home-plate account-plate mx-auto my-6 w-full max-w-2xl sm:my-8">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">Your follows email</h1>
            <p className="home-tagline">
              New releases from the artists and labels you follow, every Friday.
            </p>
          </div>
        </header>
        {data.mode === "manage" ? (
          <ManageFollows follows={data.follows} subscribed={data.subscribed} token={data.token} />
        ) : data.mode === "unsubscribe" ? (
          <StopEmail token={data.token} />
        ) : (
          <div className="account-stack">
            <p className="account-muted">{COPY.invalid}</p>
            <Button
              className="self-start"
              nativeButton={false}
              render={<Link to="/account" />}
              variant="outline"
            >
              Go to your account
            </Button>
          </div>
        )}
      </article>
    </main>
  );
}

function StopEmail({ token }: { token: string }) {
  const [phase, setPhase] = useState<"done" | "error" | "idle" | "working">("idle");
  const [subscribed, setSubscribed] = useState(true);
  const query = `token=${encodeURIComponent(token)}`;

  async function stop() {
    if (phase === "working") {
      return;
    }

    setPhase("working");
    const ok = await digestRequest(`/api/v1/follow-digest/unsubscribe?${query}`, "POST");

    if (ok) {
      setSubscribed(false);
    }

    setPhase(ok ? "done" : "error");
  }

  return (
    <div className="account-stack">
      <p aria-live="polite" className="account-muted">
        {phase === "done" ? COPY.done : COPY.prompt}
      </p>
      {subscribed ? (
        <Button
          aria-disabled={phase === "working"}
          className="self-start"
          onClick={() => void stop()}
          type="button"
        >
          {phase === "working" ? "Stopping…" : COPY.stop}
        </Button>
      ) : null}
      <p aria-live="assertive" className="account-muted">
        {phase === "error" ? COPY.failed : ""}
      </p>
    </div>
  );
}

function ManageFollows({
  follows: initialFollows,
  subscribed: initialSubscribed,
  token,
}: {
  follows: DigestFollow[];
  subscribed: boolean;
  token: string;
}) {
  const [follows, setFollows] = useState(initialFollows);
  const [subscribed, setSubscribed] = useState(initialSubscribed);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const query = `token=${encodeURIComponent(token)}`;

  async function toggleEmail() {
    if (busy) {
      return;
    }

    setBusy(true);
    setMessage("");

    const ok = await digestRequest(
      `/api/v1/follow-digest/${subscribed ? "unsubscribe" : "subscribe"}?${query}`,
      "POST",
    );

    if (ok) {
      setSubscribed(!subscribed);
      setMessage(subscribed ? "Follows email off." : "Follows email on.");
    } else {
      setMessage(COPY.failed);
    }

    setBusy(false);
  }

  async function unfollow(follow: DigestFollow, index: number) {
    if (busy) {
      return;
    }

    setBusy(true);
    setMessage("");

    const ok = await digestRequest(
      `/api/v1/follow-digest/follows/${encodeURIComponent(follow.id)}?${query}`,
      "DELETE",
    );

    if (ok) {
      setFollows((current) => current.filter((row) => row.id !== follow.id));
      setMessage(`Unfollowed ${follow.name}.`);
      requestAnimationFrame(() => {
        const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
        const next = buttons?.[Math.min(index, buttons.length - 1)];

        (next ?? headingRef.current)?.focus();
      });
    } else {
      setMessage(`I couldn't unfollow ${follow.name} just now. Try again in a moment.`);
    }

    setBusy(false);
  }

  return (
    <div className="account-stack">
      <section className="account-section">
        <h2>{COPY.emailHeading}</h2>
        <p className="account-muted">{subscribed ? COPY.emailOn : COPY.emailOff}</p>
        <Button
          aria-disabled={busy}
          className="self-start"
          onClick={() => void toggleEmail()}
          type="button"
          variant="outline"
        >
          {subscribed ? COPY.stop : COPY.start}
        </Button>
      </section>
      <section className="account-section">
        <h2 ref={headingRef} tabIndex={-1}>
          Following
        </h2>
        {follows.length === 0 ? (
          <p className="account-muted">
            Not following anyone. Tap Follow on an artist or label and they show up here.
          </p>
        ) : (
          <ul className="account-list" ref={listRef}>
            {follows.map((follow, index) => (
              <li className="account-set-row" key={follow.id}>
                {follow.kind === "artist" ? (
                  <Link params={{ slug: follow.slug }} to="/artist/$slug">
                    {follow.name}
                  </Link>
                ) : (
                  <Link params={{ slug: follow.slug }} to="/label/$slug">
                    {follow.name}
                  </Link>
                )}
                <span className="account-set-actions">
                  <span className="account-muted text-xs">
                    {follow.kind === "artist" ? "Artist" : "Label"}
                  </span>
                  <Button
                    aria-disabled={busy}
                    aria-label={`Unfollow ${follow.name}`}
                    onClick={() => void unfollow(follow, index)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Unfollow
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p aria-live="polite" className="account-muted">
        {message}
      </p>
    </div>
  );
}

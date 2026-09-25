import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { spriteUrl } from "@fluncle/sprites";
import { type ReactNode, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { fetchRandomFindingLogId } from "@/lib/tracks";

const COPY = {
  body: "I went looking and came up empty. Whatever sat here fell into the black hole a long time back, so let me throw you at a finding that actually lands.",

  browse: "Browse the log",

  heading: "Nothing at this coordinate.",

  throwCta: "Take me to a finding",
  throwing: "Taking you there…",
} as const;

export function NotFoundBlackHole(): ReactNode {
  const router = useRouter();

  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [throwing, setThrowing] = useState(false);

  const deadCoordinate = `fluncle://${pathname.replace(/^\/+/, "")}`;

  async function handleThrow(event: React.MouseEvent<HTMLAnchorElement>): Promise<void> {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }

    event.preventDefault();

    if (throwing) {
      return;
    }

    setThrowing(true);

    const logId = await fetchRandomFindingLogId();

    if (logId) {
      await router.navigate({ params: { logId }, to: "/log/$logId" });

      return;
    }

    await router.navigate({ to: "/log" });
  }

  return (
    <main className="void404">
      <title>Nothing at this coordinate · Fluncle</title>
      <meta content="noindex, follow" name="robots" />

      <div aria-hidden="true" className="void404-stage">
        <span className="void404-glow" />
        <img
          alt=""
          className="void404-disc"
          src={spriteUrl({ collection: "void", id: "accretion" })}
        />
        <img
          alt=""
          className="void404-ring"
          src={spriteUrl({ collection: "void", id: "event-horizon" })}
        />
        <span className="void404-orbit">
          <img
            alt=""
            className="void404-debris"
            src={spriteUrl({ collection: "void", id: "discman" })}
          />
        </span>
      </div>

      <div className="void404-copy">
        <p className="void404-coord">{deadCoordinate}</p>
        <h1 className="void404-title">{COPY.heading}</h1>
        <p className="void404-body">{COPY.body}</p>
        <div className="void404-actions">
          <Button
            aria-busy={throwing}
            aria-live="polite"
            className="void404-throw"
            nativeButton={false}
            // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
            render={<a href="/log" onClick={handleThrow} />}
          >
            {throwing ? COPY.throwing : COPY.throwCta}
          </Button>
          <Link className="void404-browse" to="/log">
            {COPY.browse}
          </Link>
        </div>
      </div>
    </main>
  );
}

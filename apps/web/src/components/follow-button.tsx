import { BellSimpleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { Popover, PopoverTrigger } from "@fluncle/ui/components/popover";
import { LazyPopupBoundary } from "@/components/lazy-popup-boundary";
import { authClient } from "@/lib/auth-client";
import { authedJsonFetch } from "@/lib/authed-fetch";
import { lazyNamed } from "@/lib/lazy-named";

const loadFollowPopover = () => import("@/components/follow-popover");
const FollowPopover = lazyNamed(loadFollowPopover, "FollowPopover");

function prefetchFollowPopover(): void {
  void loadFollowPopover();
}

type Face = "following" | "loading" | "not-following" | "signed-out";

type FollowKind = "artist" | "label";

type FollowRow = { entityId: string; id: string; kind: string };

const FOLLOW_PARAM = "follow";
const ERROR_PARAM = "error";

export const FOLLOW_LINK_EXPIRED =
  "That link expired or was already used. Tap Follow and I'll send a fresh one.";

export const FOLLOW_DID_NOT_STICK =
  "You're signed in, but the follow didn't stick. Tap Follow to try again.";

export function followingNote(name: string, followsEmail: boolean): string {
  return followsEmail
    ? `Following ${name}. I'll email you their new releases every Friday.`
    : `Following ${name}. Your follows email is off, so switch it on from your account to get their new releases.`;
}

export function followLanding(search: string): { error: boolean; intent?: string } {
  const params = new URLSearchParams(search);
  const intent = params.get(FOLLOW_PARAM) ?? undefined;

  return { error: params.has(ERROR_PARAM), intent: intent || undefined };
}

export function withoutFollowParams(pathname: string, search: string): string {
  const params = new URLSearchParams(search);

  params.delete(FOLLOW_PARAM);
  params.delete(ERROR_PARAM);

  const rest = params.toString();

  return rest ? `${pathname}?${rest}` : pathname;
}

async function readFollowId(kind: FollowKind, entityId: string): Promise<string | undefined> {
  const response = await fetch("/api/v1/me/follows");

  if (!response.ok) {
    return undefined;
  }

  const body = (await response.json()) as { follows?: FollowRow[] };

  return body.follows?.find((row) => row.kind === kind && row.entityId === entityId)?.id;
}

export function FollowButton({
  entityId,
  kind,
  name,
}: {
  entityId: string;
  kind: FollowKind;
  name: string;
}) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const userId = session?.user.id;
  const [face, setFace] = useState<Face>("loading");
  const [followId, setFollowId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const landing = useRef<{ error: boolean; intent?: string } | undefined>(undefined);

  function onOpenChange(next: boolean): void {
    if (next) {
      setActivated(true);
    }

    setOpen(next);
  }

  useEffect(() => {
    if (landing.current !== undefined) {
      return;
    }

    landing.current = followLanding(window.location.search);

    if (landing.current.intent || landing.current.error) {
      router.history.replace(withoutFollowParams(window.location.pathname, window.location.search));
    }

    if (landing.current.error) {
      setNote(FOLLOW_LINK_EXPIRED);
    }
  }, [router]);

  useEffect(() => {
    if (isPending) {
      return;
    }

    let cancelled = false;

    if (!userId) {
      setFace("signed-out");
      setFollowId(undefined);

      return;
    }

    setFace("loading");

    void (async () => {
      const intent = landing.current?.intent;

      if (intent) {
        landing.current = { error: false };

        const response = await authedJsonFetch("/api/v1/me/follows", {
          body: JSON.stringify({ intent }),
          method: "POST",
        });

        if (cancelled) {
          return;
        }

        if (response?.ok) {
          const body = (await response.json()) as { followsEmail?: boolean };

          setNote(followingNote(name, body.followsEmail !== false));
        } else {
          setNote(FOLLOW_DID_NOT_STICK);
        }
      }

      const id = await readFollowId(kind, entityId).catch(() => undefined);

      if (!cancelled) {
        setFollowId(id);
        setFace(id ? "following" : "not-following");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entityId, isPending, kind, name, userId]);

  async function follow() {
    if (busy || face === "loading") {
      return;
    }

    setBusy(true);
    setNote("");

    try {
      const response = await authedJsonFetch("/api/v1/me/follows", {
        body: JSON.stringify({ entityId, kind }),
        method: "POST",
      });

      if (response?.ok) {
        const body = (await response.json()) as {
          follow?: { id?: string };
          followsEmail?: boolean;
        };

        setFollowId(body.follow?.id);
        setFace("following");
        setNote(followingNote(name, body.followsEmail !== false));
      } else if (response) {
        setNote(`I couldn't follow ${name} just now. Try again in a moment.`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function unfollow() {
    if (!followId || busy) {
      return;
    }

    setBusy(true);
    setNote("");

    try {
      const response = await authedJsonFetch(`/api/v1/me/follows/${followId}`, {
        method: "DELETE",
      });

      if (response?.ok) {
        setFollowId(undefined);
        setFace("not-following");
        setNote(`Unfollowed ${name}.`);
      } else if (response) {
        setNote(`I couldn't unfollow ${name} just now. Try again in a moment.`);
      }
    } finally {
      setBusy(false);
    }
  }

  const following = face === "following";
  const label = following ? "Following" : "Follow";
  const icon = (
    <BellSimpleIcon aria-hidden="true" className="size-4" weight={following ? "fill" : "bold"} />
  );

  return (
    <div className="follow-control">
      {face === "signed-out" ? (
        <Popover onOpenChange={onOpenChange} open={open}>
          <PopoverTrigger
            render={
              <Button
                aria-label={`Follow ${name}`}
                className="shrink-0"
                onFocus={prefetchFollowPopover}
                onPointerDown={prefetchFollowPopover}
                onPointerEnter={prefetchFollowPopover}
                size="sm"
                type="button"
                variant="outline"
              />
            }
          >
            {icon}
            Follow
          </PopoverTrigger>
          {open || activated ? (
            <LazyPopupBoundary>
              <Suspense fallback={null}>
                <FollowPopover entityId={entityId} kind={kind} name={name} />
              </Suspense>
            </LazyPopupBoundary>
          ) : null}
        </Popover>
      ) : (
        <Button
          aria-disabled={busy || face === "loading"}
          aria-label={`${label} ${name}`}
          className="shrink-0"
          onClick={() => void (following ? unfollow() : follow())}
          size="sm"
          type="button"
          variant="outline"
        >
          {icon}
          {label}
        </Button>
      )}
      <p aria-live="polite" className="follow-note">
        {note}
      </p>
    </div>
  );
}

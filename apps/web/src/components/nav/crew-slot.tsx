import { CaretDownIcon, UserCircleIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, Suspense, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { DropdownMenu, DropdownMenuTrigger } from "@fluncle/ui/components/dropdown-menu";
import { LazyPopupBoundary } from "@/components/lazy-popup-boundary";
import { authClient } from "@/lib/auth-client";
import { lazyNamed } from "@/lib/lazy-named";

const loadCrewMenuContent = () => import("@/components/nav/crew-menu-content");
const CrewMenuContent = lazyNamed(loadCrewMenuContent, "CrewMenuContent");

function prefetchCrewMenuContent(): void {
  void loadCrewMenuContent();
}

function JoinButton({ glow }: { glow: boolean }): ReactNode {
  return (
    <Button
      className={glow ? "crew-glow" : undefined}
      nativeButton={false}
      render={<Link aria-label="Join the crew" to="/account" />}
      size="sm"
      variant="outline"
    >
      <UsersThreeIcon aria-hidden="true" weight="bold" />
      <span className="crew-slot-label">Join the crew</span>
    </Button>
  );
}

function AccountMenu({ image, name }: { image: null | string; name: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);

  function onOpenChange(next: boolean): void {
    if (next) {
      setActivated(true);
    }

    setOpen(next);
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        aria-label="Your account"
        className="crew-trigger"
        onFocus={prefetchCrewMenuContent}
        onPointerDown={prefetchCrewMenuContent}
        onPointerEnter={prefetchCrewMenuContent}
      >
        {image ? (
          <img alt="" className="crew-trigger-avatar" src={image} />
        ) : (
          <UserCircleIcon aria-hidden="true" className="crew-trigger-icon" weight="bold" />
        )}
        <span className="crew-slot-label">{name}</span>
        <CaretDownIcon aria-hidden="true" className="crew-trigger-caret" weight="bold" />
      </DropdownMenuTrigger>
      {open || activated ? (
        <LazyPopupBoundary>
          <Suspense fallback={null}>
            <CrewMenuContent name={name} />
          </Suspense>
        </LazyPopupBoundary>
      ) : null}
    </DropdownMenu>
  );
}

export function CrewSlot({ home }: { home: boolean }): ReactNode {
  const { data: session } = authClient.useSession();
  const user = session?.user;

  if (!user) {
    return <JoinButton glow={home} />;
  }

  const name = user.name || (user.displayUsername ?? user.username ?? "cosmonaut");

  return <AccountMenu image={user.image ?? null} name={name} />;
}

import {
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@fluncle/ui/components/popover";
import { MagicLinkForm } from "@/components/account/magic-link-form";

export function FollowPopover({
  entityId,
  kind,
  name,
}: {
  entityId: string;
  kind: "artist" | "label";
  name: string;
}) {
  return (
    <PopoverContent align="start" className="follow-popover w-[min(20rem,calc(100vw-1rem))] gap-3">
      <PopoverHeader>
        <PopoverTitle>Follow {name}</PopoverTitle>
        <PopoverDescription>
          I&rsquo;ll email you {name}&rsquo;s new releases every Friday. Nothing new, no email.
        </PopoverDescription>
      </PopoverHeader>
      <MagicLinkForm
        callbackURL={typeof window === "undefined" ? "/" : window.location.pathname}
        hint={`No password. The link signs you in and follows ${name} for you.`}
        metadata={{ follow: { entityId, kind } }}
        sentNote={`Open it and you're following ${name}.`}
      />
    </PopoverContent>
  );
}

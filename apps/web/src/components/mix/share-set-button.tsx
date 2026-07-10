import { LinkSimpleIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { siteUrl } from "@/lib/fluncle-links";
import { Button } from "@fluncle/ui/components/button";

// The set's one gold primary (the §3.0 canon gate: exactly one), sitting in the
// plate masthead bottom-right beside the nameplate. The share URL is pure over the
// serialized `?set=` — the chain lives in the URL, so the header needs no chain
// state of its own.
export function ShareSetButton({ serializedSet }: { serializedSet: string }) {
  const share = async () => {
    const url = `${siteUrl}/mix?set=${serializedSet}&view=play`;

    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "A Fluncle mix", url });
      } else {
        await navigator.clipboard.writeText(url);
        toast("Set link copied. Send it to the crew.");
      }
    } catch {
      // A cancelled share sheet is not an error; a clipboard failure gets the fallback.
      try {
        await navigator.clipboard.writeText(url);
        toast("Set link copied. Send it to the crew.");
      } catch {
        toast("Couldn't copy the link.");
      }
    }
  };

  return (
    <Button className="shrink-0" onClick={() => void share()} variant="default">
      <LinkSimpleIcon className="size-4" />
      Copy set link
    </Button>
  );
}

import { LinkSimpleIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { siteUrl } from "@/lib/fluncle-links";
import { Button } from "@fluncle/ui/components/button";

// The set's one gold primary (the §3.0 canon gate: exactly one), sitting in the plate
// masthead bottom-right beside the nameplate. The share URL is pure over the serialized
// `?set=` + `?taste=` — the chain AND the taste behind it live in the URL, so the header
// needs no state of its own.
//
// THE SEED TRAVELS WITH THE SET, and that is deliberate: the link does not just hand someone
// your tracklist, it hands them the lane you built it in. They land on your set, hit "Chain
// your own set from here", and the rail is already tuned to the artists you seeded — so the
// thing they carry on building sounds like the thing they were sent. A set link that dropped
// the seed would hand them a dead tracklist and make them start the tool over.
export function ShareSetButton({
  serializedSet,
  serializedTaste,
}: {
  serializedSet: string;
  serializedTaste: string;
}) {
  const share = async () => {
    const taste = serializedTaste ? `&taste=${serializedTaste}` : "";
    const url = `${siteUrl}/mix?set=${serializedSet}${taste}&view=play`;

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

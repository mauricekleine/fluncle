import { LinkSimpleIcon } from "@phosphor-icons/react";
import { announce } from "@/lib/announce";
import { siteUrl } from "@/lib/fluncle-links";
import { Button } from "@fluncle/ui/components/button";

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
        announce("Set link copied. Send it to the crew.");
      }
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        announce("Set link copied. Send it to the crew.");
      } catch {
        announce("Couldn't copy the link.");
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

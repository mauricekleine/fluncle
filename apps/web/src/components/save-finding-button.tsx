import { BookmarkSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { authedJsonFetch } from "@/lib/authed-fetch";

export function SaveFindingButton({ logId, trackId }: { logId: string; trackId: string }) {
  const [label, setLabel] = useState("Save finding");

  async function save() {
    // `undefined` means the session lapsed and the helper already sent them to sign in.
    const response = await authedJsonFetch("/api/v1/me/saved-findings", {
      body: JSON.stringify({ logId, trackId }),
      method: "POST",
    });

    if (!response) {
      return;
    }

    setLabel(response.ok ? "Saved" : "Could not save");
  }

  return (
    <Button size="lg" type="button" variant="outline" onClick={() => void save()}>
      <BookmarkSimpleIcon className="size-4" weight="bold" />
      {label}
    </Button>
  );
}

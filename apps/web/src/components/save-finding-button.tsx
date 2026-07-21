import { BookmarkSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";

export function SaveFindingButton({ logId, trackId }: { logId: string; trackId: string }) {
  const [label, setLabel] = useState("Save finding");

  async function save() {
    const tokenResponse = await fetch("/api/v1/me/csrf");

    if (tokenResponse.status === 401) {
      window.location.href = "/account";
      return;
    }

    const { csrfToken } = (await tokenResponse.json()) as { csrfToken?: string };
    const response = await fetch("/api/v1/me/saved-findings", {
      body: JSON.stringify({ logId, trackId }),
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken ?? "" },
      method: "POST",
    });

    if (response.status === 401) {
      window.location.href = "/account";
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

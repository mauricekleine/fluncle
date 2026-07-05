import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Toaster } from "@fluncle/ui/components/sonner";

// The OAuth connect routes (Spotify / YouTube / Mixcloud) redirect to
// `/admin?<service>=connected` after storing their token server-side. This mounts
// the toaster and turns that marker into a toast, then strips it from the URL so a
// refresh doesn't re-fire it. Lives in the admin shell — the public app stays
// toaster-free.
const CONNECTED_LABELS: Record<string, string> = {
  mixcloud: "Mixcloud connected",
  spotify: "Spotify connected",
  youtube: "YouTube connected",
};

export function ConnectedToast() {
  const router = useRouter();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) {
      return;
    }

    // Read the raw query string: the board's validateSearch narrows to {mix,stage},
    // so the `<service>` marker is only on window.location, not the typed search.
    const params = new URLSearchParams(window.location.search);
    const service = Object.keys(CONNECTED_LABELS).find((key) => params.get(key) === "connected");

    if (!service) {
      return;
    }

    fired.current = true;
    toast.success(CONNECTED_LABELS[service]);

    // Strip the marker via the router's own history (keeps mix/stage, stays in sync).
    params.delete(service);
    const query = params.toString();
    router.history.replace(`${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [router]);

  return <Toaster />;
}

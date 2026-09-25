import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Toaster } from "@fluncle/ui/components/sonner";

const CONNECTED_LABELS: Record<string, string> = {
  mixcloud: "Mixcloud connected",
  spotify: "Spotify connected",
  tiktok: "TikTok connected",
  youtube: "YouTube connected",
};

export function ConnectedToast() {
  const router = useRouter();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const service = Object.keys(CONNECTED_LABELS).find((key) => params.get(key) === "connected");

    if (!service) {
      return;
    }

    fired.current = true;
    toast.success(CONNECTED_LABELS[service]);

    params.delete(service);
    const query = params.toString();
    router.history.replace(`${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [router]);

  return <Toaster />;
}

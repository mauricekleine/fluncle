import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

export function useNotificationObserver() {
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    function route(response: Notifications.NotificationResponse | null) {
      const url = response?.notification.request.content.data?.url;
      if (typeof url === "string") {
        router.push(url);
      }
    }

    void Notifications.getLastNotificationResponseAsync().then((r) => {
      if (mounted) {
        route(r);
      }
    });
    const sub = Notifications.addNotificationResponseReceivedListener(route);

    return () => {
      mounted = false;
      sub.remove();
    };
  }, [router]);
}

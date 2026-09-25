import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function ensureAndroidChannels() {
  if (Platform.OS !== "android") {
    return;
  }
  await Notifications.setNotificationChannelAsync("findings", {
    importance: Notifications.AndroidImportance.HIGH,
    name: "New findings",
  });
  await Notifications.setNotificationChannelAsync("mixtapes", {
    importance: Notifications.AndroidImportance.HIGH,
    name: "New mixtapes",
  });
}

function easProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

export type PushRegistration =
  | { status: "granted"; token: string | null }
  | { status: "denied" }
  | { status: "error"; reason: string };

export async function registerForPush(): Promise<PushRegistration> {
  try {
    await ensureAndroidChannels();
    let granted = (await Notifications.getPermissionsAsync()).granted;
    if (!granted) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) {
      return { status: "denied" };
    }

    const projectId = easProjectId();

    if (!projectId) {
      return { status: "granted", token: null };
    }

    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { status: "granted", token: token.data };
  } catch (e) {
    return { reason: e instanceof Error ? e.message : "unknown", status: "error" };
  }
}

export const devicePlatform = (): "ios" | "android" => (Platform.OS === "ios" ? "ios" : "android");

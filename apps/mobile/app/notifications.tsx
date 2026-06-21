import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { useRegisterDevice } from "@/api/hooks";
import { devicePlatform, registerForPush } from "@/push/notifications";
import { color, font } from "@/theme/tokens";

type State = "idle" | "working" | "on" | "denied" | "error";

// Push consent surface (RFC Unit 5 / Apple 4.5.4: in-app consent language before
// the system prompt). Reached after first value, never cold on launch. Copy is
// in-voice but a final copywriting-fluncle pass is a follow-up.
export default function NotificationsScreen() {
  const router = useRouter();
  const register = useRegisterDevice();
  const [state, setState] = useState<State>("idle");

  async function enable() {
    setState("working");
    const res = await registerForPush();
    if (res.status === "granted") {
      if (res.token) {
        register.mutate({ platform: devicePlatform(), token: res.token });
      }
      setState("on");
    } else if (res.status === "denied") {
      setState("denied");
    } else {
      setState("error");
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1, gap: 16, padding: 20 }}>
        <Text style={[font.display, { color: color.starlightCream, fontSize: 26 }]}>
          Pings from the Galaxy
        </Text>
        <Text style={[font.body, { color: color.stardust }]}>
          Get a quiet nudge when Fluncle logs a new banger, and when he surfaces from a dream with a
          fresh mixtape. No noise, just the finds. Turn it off anytime in your phone&apos;s
          settings.
        </Text>

        {state === "on" ? (
          <Text style={[font.body, { color: color.eclipseGlow }]}>
            You&apos;re tuned in. Catch you out there, cosmonaut.
          </Text>
        ) : state === "denied" ? (
          <Text style={[font.body, { color: color.reentryRed }]}>
            Notifications are switched off for Fluncle in your phone&apos;s settings. Flip them on
            there to get the pings.
          </Text>
        ) : state === "error" ? (
          <Text style={[font.body, { color: color.reentryRed }]}>
            Couldn&apos;t set that up just now. Try again in a moment.
          </Text>
        ) : (
          <HeatButton
            label={state === "working" ? "Tuning in…" : "Enable pings"}
            onPress={enable}
            disabled={state === "working"}
          />
        )}

        <Pressable
          onPress={() => router.back()}
          style={{ alignItems: "center", paddingVertical: 10 }}
        >
          <Text style={[font.label, { color: color.stardust }]}>Not now</Text>
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

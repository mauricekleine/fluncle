import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { useRegisterDevice } from "@/api/hooks";
import { useNotificationPrefs } from "@/lib/notification-prefs";
import { type PushCategory, mutedCategories } from "@/lib/push-prefs";
import { devicePlatform, registerForPush } from "@/push/notifications";
import { color, font } from "@/theme/tokens";

type State = "idle" | "working" | "on" | "denied" | "error";

export default function NotificationsScreen() {
  const router = useRouter();
  const register = useRegisterDevice();
  const { prefs, setCategory } = useNotificationPrefs();
  const [state, setState] = useState<State>("idle");

  const [syncFailed, setSyncFailed] = useState(false);

  async function enable() {
    setState("working");
    const res = await registerForPush();
    if (res.status === "granted") {
      if (res.token) {
        register.mutate({
          mutedCategories: mutedCategories(prefs),
          platform: devicePlatform(),
          token: res.token,
        });
      }
      setState("on");
    } else if (res.status === "denied") {
      setState("denied");
    } else {
      setState("error");
    }
  }

  async function toggleCategory(category: PushCategory, enabled: boolean) {
    const next = setCategory(category, enabled);
    if (state !== "on") {
      return;
    }
    const res = await registerForPush();
    if (res.status === "granted" && res.token) {
      register.mutate(
        {
          mutedCategories: mutedCategories(next),
          platform: devicePlatform(),
          token: res.token,
        },
        {
          onError: () => setSyncFailed(true),
          onSuccess: () => setSyncFailed(false),
        },
      );
    } else if (res.status === "granted") {
      setSyncFailed(false);
    } else {
      setSyncFailed(true);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1, gap: 16, padding: 20 }}>
        <Text style={[font.display, { color: color.starlightCream, fontSize: 26 }]}>
          Notifications
        </Text>
        <Text style={[font.body, { color: color.stardust }]}>
          Get a quiet nudge when Fluncle logs a new banger, and when he surfaces from a dream with a
          fresh mixtape. No noise, just the finds. Turn it off anytime in your phone&apos;s
          settings.
        </Text>

        <View style={{ gap: 4 }}>
          <CategoryToggle
            label="New findings"
            value={prefs.findings}
            onValueChange={(next) => void toggleCategory("findings", next)}
          />
          <CategoryToggle
            label="New mixtapes"
            value={prefs.mixtapes}
            onValueChange={(next) => void toggleCategory("mixtapes", next)}
          />
        </View>

        {syncFailed ? (
          <Text style={[font.body, { color: color.stardust }]}>
            That didn&apos;t reach Fluncle just now. It&apos;s saved on this phone.
          </Text>
        ) : null}

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
            label={state === "working" ? "Tuning in…" : "Enable notifications"}
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

function CategoryToggle({
  label,
  onValueChange,
  value,
}: {
  label: string;
  onValueChange: (next: boolean) => void;
  value: boolean;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        flexDirection: "row",
        justifyContent: "space-between",
        minHeight: 44,
      }}
    >
      <Text style={[font.body, { color: color.starlightCream }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        ios_backgroundColor={color.dustLine}
        onValueChange={onValueChange}
        thumbColor={color.starlightCream}
        trackColor={{ false: color.dustLine, true: color.eclipseGold }}
        value={value}
      />
    </View>
  );
}

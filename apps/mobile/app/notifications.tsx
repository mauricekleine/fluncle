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

// Push consent surface (RFC Unit 5 / Apple 4.5.4: in-app consent language before
// the system prompt). Reached after first value, never cold on launch. Below consent
// sit the two per-category toggles ("New findings", "New mixtapes"): they persist on
// this device and re-register it with the updated `mutedCategories` so the crew hears
// only the pushes they asked for. A toggle that couldn't reach Fluncle says so quietly.
export default function NotificationsScreen() {
  const router = useRouter();
  const register = useRegisterDevice();
  const { prefs, setCategory } = useNotificationPrefs();
  const [state, setState] = useState<State>("idle");
  // Set only when a category change couldn't reach the server; the choice is always
  // saved on the device regardless.
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

  // Persist the toggle locally (always), then — only once notifications are actually
  // on — re-register the device with the fresh muted set. Before that, the choice just
  // waits and rides along on the next enable().
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
      // Granted but no token yet (no EAS project) — nothing to sync, saved on device.
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

        {/* The two per-category toggles. Literal control labels (the Chrome Rule), the
            same nouns the Android channels carry. Eclipse Gold rides the ON track. */}
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

// One per-category toggle row: the literal label and a Switch, the ON track in Eclipse
// Gold (One Sun). The label doubles as the switch's a11y label so a screen reader
// announces which category it toggles.
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

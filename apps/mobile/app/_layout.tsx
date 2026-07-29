import "../global.css";
import "@/push/notifications"; // installs the foreground notification handler

import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, focusManager, onlineManager } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { Oxanium_400Regular, Oxanium_800ExtraBold, useFonts } from "@expo-google-fonts/oxanium";
import { SpaceGrotesk_400Regular, SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk";
import { configureAudioSession } from "@/audio/session";
import { registerMutationDefaults } from "@/api/mutation-defaults";
import { meFetch } from "@/lib/auth-client";
import { configureKeyNotationSync } from "@/lib/key-notation";
import { isOnline } from "@/lib/network-status";
import { QUERY_GC_TIME_MS, createPersistConfig } from "@/lib/persist-config";
import { useNotificationObserver } from "@/push/use-notification-observer";
import { color } from "@/theme/tokens";

// Wire the authenticated /me fetch into the key-notation profile-sync layer once, at app
// startup, so a returning signed-in user's notation adopts on the Mix tab without opening
// the account screen first (the layer is RN-shallow and injects this rather than importing
// the native auth client — see key-notation.ts).
configureKeyNotationSync(meFetch);

// Teach TanStack Query whether the device can actually reach anything. Left alone the
// online manager starts `online: true` and only flips on a browser `online`/`offline`
// event that never fires in React Native, so every request in a tunnel FAILS instead of
// parking as a paused mutation the app can replay later. `setEventListener` runs this
// setup immediately, so the first read below doubles as the seed.
onlineManager.setEventListener((setOnline) => {
  Network.getNetworkStateAsync()
    .then((state) => setOnline(isOnline(state)))
    // A failed read is not evidence of being offline; leave the manager online (see
    // network-status.ts on why the two mistakes cost different amounts).
    .catch(() => setOnline(true));

  const subscription = Network.addNetworkStateListener((state) => setOnline(isOnline(state)));
  return () => subscription.remove();
});

// One persister for the app's lifetime, over the storage Expo SDK 56 already pins. This
// slice deliberately stops at AsyncStorage: the SQLite move is its own slice, and the
// persister's storage interface is structural, so it is an import swap when it comes.
const persister = createAsyncStoragePersister({ storage: AsyncStorage });

// `expoConfig.version` is the shipped app version; combined with a local schema constant it
// decides which restored caches are still readable by this build.
const persistConfig = createPersistConfig(Constants.expoConfig?.version);

export default function RootLayout() {
  const [client] = useState(() => {
    // gcTime is stated here rather than left at react-query's 5-minute default because the
    // persister's maxAge cannot exceed it — see persist-config.ts.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: QUERY_GC_TIME_MS } },
    });
    // Before the provider restores anything: a dehydrated mutation has no function of its
    // own, so replay needs these registered against the same key.
    registerMutationDefaults(queryClient);
    return queryClient;
  });
  // One gate for every face: Oxanium (brand + numerals) and Space Grotesk (the
  // reading face — body/title/label). `if (!fontsLoaded) return null` below holds
  // the tree until all four cuts are in, so there is no flash of system font.
  const [fontsLoaded] = useFonts({
    Oxanium_400Regular,
    Oxanium_800ExtraBold,
    SpaceGrotesk_400Regular,
    SpaceGrotesk_700Bold,
  });

  useEffect(() => {
    configureAudioSession();
  }, []);

  // The focus half of the same story: react-query's focus manager listens for a DOM
  // `visibilitychange` that never fires here, so without this a `refetchOnWindowFocus`
  // query never notices the app coming back from the background.
  useEffect(() => {
    if (Platform.OS === "web") {
      return;
    }
    const subscription = AppState.addEventListener("change", (status) => {
      focusManager.setFocused(status === "active");
    });
    return () => subscription.remove();
  }, []);

  useNotificationObserver();

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider
          client={client}
          persistOptions={{ ...persistConfig, persister }}
          // The ONLY safe place to resume: the restore has finished here, so a queued
          // submission is on the client before anything tries to replay it. Resuming any
          // earlier races the hydration and silently drops the queue.
          onSuccess={() => void client.resumePausedMutations()}
        >
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: color.deepField },
              headerShown: false,
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="account" options={{ presentation: "modal" }} />
            <Stack.Screen name="log/[id]" options={{ presentation: "modal" }} />
            <Stack.Screen name="mixtape/[id]" />
            <Stack.Screen name="notifications" options={{ presentation: "modal" }} />
            <Stack.Screen name="submit" options={{ presentation: "modal" }} />
          </Stack>
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

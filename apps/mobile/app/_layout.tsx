import "../global.css";
import "@/push/notifications";

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
import { useReplicaSync } from "@/lib/replica";
import { useNotificationObserver } from "@/push/use-notification-observer";
import { color } from "@/theme/tokens";

configureKeyNotationSync(meFetch);

onlineManager.setEventListener((setOnline) => {
  Network.getNetworkStateAsync()
    .then((state) => setOnline(isOnline(state)))

    .catch(() => setOnline(true));

  const subscription = Network.addNetworkStateListener((state) => setOnline(isOnline(state)));
  return () => subscription.remove();
});

const persister = createAsyncStoragePersister({ storage: AsyncStorage });

const persistConfig = createPersistConfig(Constants.expoConfig?.version);

export default function RootLayout() {
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: QUERY_GC_TIME_MS } },
    });

    registerMutationDefaults(queryClient);
    return queryClient;
  });

  const [fontsLoaded] = useFonts({
    Oxanium_400Regular,
    Oxanium_800ExtraBold,
    SpaceGrotesk_400Regular,
    SpaceGrotesk_700Bold,
  });

  useEffect(() => {
    configureAudioSession();
  }, []);

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

  useReplicaSync();

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider
          client={client}
          persistOptions={{ ...persistConfig, persister }}

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

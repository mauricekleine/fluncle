import "../global.css";
import "@/push/notifications"; // installs the foreground notification handler

import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Oxanium_400Regular, Oxanium_800ExtraBold, useFonts } from "@expo-google-fonts/oxanium";
import { configureAudioSession } from "@/audio/session";
import { useNotificationObserver } from "@/push/use-notification-observer";
import { color } from "@/theme/tokens";

export default function RootLayout() {
  const [client] = useState(() => new QueryClient());
  const [fontsLoaded] = useFonts({ Oxanium_400Regular, Oxanium_800ExtraBold });

  useEffect(configureAudioSession, []);
  useNotificationObserver();

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={client}>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: color.deepField },
              headerShown: false,
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="log/[id]" options={{ presentation: "modal" }} />
            <Stack.Screen name="notifications" options={{ presentation: "modal" }} />
          </Stack>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

import { View } from "react-native";
import { Tabs } from "expo-router";
import { color } from "@/theme/tokens";

// Working tab labels (RFC D9: "Stories" is a TikTok-ism flagged for a voice pass;
// "Feed"/"Archive" are the placeholders until copywriting-fluncle lands the names).
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: color.deepField },
        tabBarActiveTintColor: color.eclipseGold,
        tabBarInactiveTintColor: color.stardust,
        tabBarStyle: {
          backgroundColor: color.sleeveBlack,
          borderTopColor: color.dustLine,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ color: c, size }) => (
            <View
              style={{
                backgroundColor: c,
                borderRadius: 99,
                height: size * 0.5,
                width: size * 0.5,
              }}
            />
          ),
          title: "Feed",
        }}
      />
      <Tabs.Screen
        name="archive"
        options={{
          tabBarIcon: ({ color: c, size }) => (
            <View
              style={{ borderColor: c, borderWidth: 2, height: size * 0.5, width: size * 0.5 }}
            />
          ),
          title: "Archive",
        }}
      />
    </Tabs>
  );
}

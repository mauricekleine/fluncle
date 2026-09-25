import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { type SearchEntity } from "@fluncle/contracts/orpc";
import { openExternalUrl } from "@/lib/open-external-url";
import { entityWebPath } from "@/lib/search-state";
import { API_BASE } from "@/config";
import { color, font, radius } from "@/theme/tokens";

const KIND_NOUN: Record<SearchEntity["kind"], string> = {
  album: "album",
  artist: "artist",
  galaxy: "galaxy",
  label: "label",
  mixtape: "mixtape",
};

export function EntityRow({
  entity,
  isLast,
}: {
  entity: SearchEntity;
  isLast?: boolean;
}): ReactNode {
  const noun = KIND_NOUN[entity.kind];

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Open the ${noun} ${entity.name} on the web`}
      onPress={() => openExternalUrl(`${API_BASE}${entityWebPath(entity)}`)}
    >
      {({ pressed }) => (
        <View style={[styles.row, isLast ? styles.lastRow : null, pressed ? styles.pressed : null]}>
          {entity.imageUrl ? (
            <Image
              source={entity.imageUrl}
              style={styles.art}
              contentFit="cover"
              transition={200}
            />
          ) : (
            <View style={[styles.art, styles.artEmpty]} />
          )}
          <View style={styles.content}>
            <Text style={[font.title, styles.name]} numberOfLines={1} ellipsizeMode="tail">
              {entity.name}
            </Text>
          </View>
          <Ionicons
            name="open-outline"
            size={16}
            color={color.stardust}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  art: {
    borderColor: color.dustLine,
    borderRadius: radius.artwork,
    borderWidth: 1,
    height: 56,
    width: 56,
  },
  artEmpty: { backgroundColor: color.dustVeil },
  content: { flex: 1 },
  lastRow: { borderBottomColor: "transparent" },
  name: { color: color.starlightCream },
  pressed: { backgroundColor: color.goldVeil },
  row: {
    alignItems: "center",
    borderBottomColor: color.dustLine,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});

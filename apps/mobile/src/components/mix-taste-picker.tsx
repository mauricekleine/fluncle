import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { type MixArtist } from "@fluncle/contracts";
import { useMixableArtists } from "@/api/hooks";
import { color, font } from "@/theme/tokens";

// The taste seed — the reader's first move on the Mix tab, and why the tool works for
// someone who has never heard of Fluncle. They can't name a track in an archive they've
// never seen, but they can always name artists they like; those artists carry vectors, so a
// handful of names is a taste. A GRID OF FACES TO TAP, not a box to type into (recognition
// beats recall — the web taste-picker's stance): the grid shows the archive's best-
// represented artists and lets them point; the search is there for the one they didn't see.
//
// Multi-select writes straight to the device store's taste seed (mix.ts) — no commit step,
// which is the phone-native move — so the openers below refetch as the reader points. Copy
// is reused verbatim from the web TastePicker (VOICE.md).

const MAX_NAME_LINES = 1;

/** One artist as a toggle tile: a circular face, the name, and a check when seeded. */
function ArtistTile({
  artist,
  onToggle,
  selected,
}: {
  artist: MixArtist;
  onToggle: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={artist.name}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onToggle}
    >
      {({ pressed }) => (
        <View style={[styles.tile, pressed ? styles.tilePressed : null]}>
          <View style={[styles.faceWrap, selected ? styles.faceWrapOn : null]}>
            {artist.imageUrl ? (
              <Image
                contentFit="cover"
                source={artist.imageUrl}
                style={styles.face}
                transition={200}
              />
            ) : (
              <View style={[styles.face, styles.faceEmpty]} />
            )}
            {selected ? (
              <View style={styles.check}>
                <Ionicons color={color.inkOnGold} name="checkmark" size={14} />
              </View>
            ) : null}
          </View>
          <Text
            numberOfLines={MAX_NAME_LINES}
            style={[
              font.body,
              styles.name,
              { color: selected ? color.eclipseGlow : color.stardust },
            ]}
          >
            {artist.name}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export function MixTastePicker({
  onToggle,
  selected,
}: {
  /** Flip an artist slug in/out of the taste seed (the screen enforces the cap). */
  onToggle: (slug: string) => void;
  /** The slugs currently seeded, so the grid shows them selected. */
  selected: string[];
}) {
  const [q, setQ] = useState("");
  const { data: artists = [] } = useMixableArtists(q);
  const seededSet = new Set(selected);

  return (
    <View style={styles.container}>
      <View>
        <Text style={[font.title, styles.heading]}>Pick a few artists you like</Text>
        <Text style={[font.body, styles.sub]}>Five or ten is plenty. I take it from there.</Text>
      </View>

      <View style={styles.searchField}>
        <Ionicons color={color.stardust} name="search" size={16} />
        <TextInput
          accessibilityLabel="Search artists"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQ}
          placeholder="Search artists"
          placeholderTextColor={color.stardust}
          returnKeyType="search"
          style={styles.searchInput}
          value={q}
        />
      </View>

      {artists.length > 0 ? (
        <View style={styles.grid}>
          {artists.map((artist) => (
            <ArtistTile
              artist={artist}
              key={artist.slug}
              onToggle={() => onToggle(artist.slug)}
              selected={seededSet.has(artist.slug)}
            />
          ))}
        </View>
      ) : (
        <Text style={[font.body, styles.empty]}>
          Nobody by that name out here. Try another spelling.
        </Text>
      )}
    </View>
  );
}

const TILE_WIDTH = 104;

const styles = StyleSheet.create({
  check: {
    alignItems: "center",
    backgroundColor: color.eclipseGold,
    borderRadius: 10,
    bottom: 0,
    height: 20,
    justifyContent: "center",
    position: "absolute",
    right: 0,
    width: 20,
  },
  container: { gap: 16 },
  empty: { color: color.stardust, paddingHorizontal: 4 },
  face: {
    borderRadius: 32,
    height: 64,
    width: 64,
  },
  faceEmpty: { backgroundColor: color.tapeBlack },
  faceWrap: {
    borderColor: "transparent",
    borderRadius: 34,
    borderWidth: 2,
    padding: 2,
  },
  faceWrapOn: { borderColor: color.eclipseGold },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  heading: { color: color.starlightCream, marginBottom: 2 },
  name: { fontSize: 12, maxWidth: TILE_WIDTH, textAlign: "center" },
  searchField: {
    alignItems: "center",
    backgroundColor: color.tapeBlackFill,
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    color: color.starlightCream,
    flex: 1,
    fontFamily: font.body.fontFamily,
    padding: 0,
  },
  sub: { color: color.stardust },
  tile: { alignItems: "center", gap: 6, width: TILE_WIDTH },
  tilePressed: { opacity: 0.7 },
});

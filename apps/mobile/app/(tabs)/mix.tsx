// The Mix tab — the set builder in the pocket, a port of the web `/mix` "Chain a set" tool.
// The app's standalone TOOL and its one surface built for a stranger rather than the crew: a
// free drum & bass mixing tool with no account (operator law — an account never gates or
// touches this feature). Name a few artists you like, pick something to open with, and the
// engine ranks what mixes in clean after it; the rail re-ranks after every add.
//
// THREE STATES, driven by the chain (mirrors the web mix-builder):
//   empty  → the taste grid (artists to tap) + the openers those artists give you
//   built  → the chain (cover-led rows, last-item undo) + the rail ranked off its tail
//   always → Share (the web URL — the link IS the state) + Start over
//
// The chain + taste persist device-local (mix.ts) and hydrate on mount. The web route is
// gated by a self-lifting archive-depth check; the app deliberately does not check it (the
// three mix ops are public + open in prod, and App Review must reach the tool) — see mix.ts.
import { useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { type MixCandidate, type MixTrack } from "@fluncle/contracts";
import { useMixableTracks, useMixOpeners } from "@/api/hooks";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { FindingRowSkeleton } from "@/components/finding-row";
import { MixRow } from "@/components/mix-row";
import { MixTastePicker } from "@/components/mix-taste-picker";
import { useMixChain } from "@/lib/mix";
import { buildMixShareUrl, MAX_TASTE_ARTISTS, mixReasonLabel, setToken } from "@/lib/mix-set";
import { chainTokens } from "@/lib/mix-store";
import { color, font } from "@/theme/tokens";

const TAGLINE =
  "Name a few artists you like. I rank what mixes in clean next, by key, tempo, and feel. Chain a set, then share it with the crew.";

export default function MixScreen() {
  const router = useRouter();
  const { add, chain, clear, ready, remove, setTaste, taste } = useMixChain();
  const [confirmingClear, setConfirmingClear] = useState(false);

  const tokens = chainTokens(chain);
  const tail = tokens[tokens.length - 1];
  const { data: candidates = [] } = useMixableTracks({ exclude: tokens, idOrLogId: tail, taste });
  const { data: openers = [], isPending: openersPending } = useMixOpeners(taste);

  // Live multi-select into the device seed (no commit step — the phone-native move), capped
  // at the same MAX_TASTE_ARTISTS the URL carries so a seed stays a seed, not a library.
  const toggleTaste = (slug: string) => {
    if (taste.includes(slug)) {
      setTaste(taste.filter((existing) => existing !== slug));
    } else if (taste.length < MAX_TASTE_ARTISTS) {
      setTaste([...taste, slug]);
    }
  };

  // Share the set as its web URL (the link IS the state), handed to the native share sheet.
  const onShare = () => {
    void Share.share({ url: buildMixShareUrl(tokens, taste) });
  };

  // "Start over" clears the set — a two-tap inline confirm (no alert dialog): the first tap
  // arms it, the second clears. Any tap that isn't the second disarms it on the next render.
  const onStartOver = () => {
    if (confirmingClear) {
      clear();
      setConfirmingClear(false);
    } else {
      setConfirmingClear(true);
    }
  };

  const building = chain.length > 0;

  return (
    <View style={styles.screen}>
      <CosmosBackdrop />
      <SafeAreaView edges={["top"]} style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.content}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={[font.display, styles.nameplate]}>Chain a set</Text>
            {building ? (
              <View style={styles.actions}>
                <HeaderAction label="Share" onPress={onShare} />
                <HeaderAction
                  danger={confirmingClear}
                  label={confirmingClear ? "Tap again to clear" : "Start over"}
                  onPress={onStartOver}
                />
              </View>
            ) : null}
          </View>
          {building ? null : <Text style={[font.body, styles.tagline]}>{TAGLINE}</Text>}

          {!ready ? (
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {Array.from({ length: 5 }, (_, i) => (
                <FindingRowSkeleton isLast={i === 4} key={i} />
              ))}
            </View>
          ) : building ? (
            <>
              <ChainList chain={chain} onRemove={remove} />
              <Rail candidates={candidates} onAdd={add} />
            </>
          ) : (
            <>
              <MixTastePicker onToggle={toggleTaste} selected={taste} />
              {taste.length > 0 ? (
                <Openers onPick={add} pending={openersPending} tracks={openers} />
              ) : null}
            </>
          )}

          {/* THE CONVERSION MOMENT (web mix-colophon): whose archive this runs on, and why it
              gets better the longer you stay. Sits at the foot, after the tool proved itself. */}
          <View style={styles.colophon}>
            <Text style={[font.body, styles.colophonText]}>
              I&apos;m Fluncle. I dig drum &amp; bass out of the far sectors and log every banger I
              bring back. This runs on that logbook, and it gets sharper every time I find another
              one.
            </Text>
            <Pressable
              accessibilityRole="link"
              hitSlop={8}
              onPress={() => router.navigate("/archive")}
            >
              <Text style={[font.label, styles.colophonLink]}>See the findings</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// What to open with, once the reader named the artists they like. The heading names the
// ACTION, never the tier of the rows under it (the Unlit Rule — a mixed list of certified +
// uncertified rows). Copy reused verbatim from the web MixOpeners.
function Openers({
  onPick,
  pending,
  tracks,
}: {
  onPick: (track: MixTrack) => void;
  pending: boolean;
  tracks: MixTrack[];
}) {
  return (
    <View style={styles.section}>
      <View>
        <Text style={[font.title, styles.sectionHeading]}>Open with</Text>
        <Text style={[font.body, styles.sectionSub]}>
          Tracks by the artists you named. Pick one and I rank what mixes in after it.
        </Text>
      </View>
      {tracks.length > 0 ? (
        <View>
          {tracks.map((track) => (
            <MixRow
              accessibilityLabel={`Open the set with ${track.title}`}
              key={setToken(track)}
              onPress={() => onPick(track)}
              track={track}
            />
          ))}
        </View>
      ) : pending ? null : (
        // Trimmed from the web's line (which offers "or search for a track yourself" — a
        // picker mobile v1 doesn't carry); the honest half is kept. Flagged for taste review.
        <Text style={[font.body, styles.stateText]}>
          I have nothing on those artists I can place yet. Pick another few.
        </Text>
      )}
    </View>
  );
}

// The chain: the set so far, cover-led. Last-item undo — only the final row carries a remove
// control (v1 is tight: no drag-reorder), so the reader peels the set back one at a time.
function ChainList({ chain, onRemove }: { chain: MixTrack[]; onRemove: (token: string) => void }) {
  return (
    <View style={styles.section}>
      {chain.map((track, index) => {
        const isLast = index === chain.length - 1;
        return (
          <MixRow
            accessibilityLabel={`${track.artists.join(", ")} — ${track.title}`}
            isLast={isLast}
            key={setToken(track)}
            track={track}
            trailing={
              isLast ? (
                <Pressable
                  accessibilityLabel={`Take ${track.title} out of the set`}
                  accessibilityRole="button"
                  hitSlop={10}
                  onPress={() => onRemove(setToken(track))}
                  style={styles.removeBtn}
                >
                  <Ionicons color={color.stardust} name="close" size={18} />
                </Pressable>
              ) : null
            }
          />
        );
      })}
    </View>
  );
}

// The rail off the chain's tail, tilted by taste, excluding the whole chain server-side. Each
// row carries its reason chip (the whole explanation — no number ever). Copy reused verbatim.
function Rail({
  candidates,
  onAdd,
}: {
  candidates: MixCandidate[];
  onAdd: (track: MixTrack) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={[font.label, styles.railHeading]}>What mixes in next, ranked</Text>
      {candidates.length > 0 ? (
        <View>
          {candidates.map((candidate) => (
            <MixRow
              accessibilityLabel={`Add ${candidate.title} to the set`}
              key={setToken(candidate)}
              onPress={() => onAdd(candidate)}
              reasonLabel={mixReasonLabel(candidate.reason)}
              track={candidate}
            />
          ))}
        </View>
      ) : (
        <Text style={[font.body, styles.stateText]}>
          Nothing keys up cleanly to this one yet. Quiet sector tonight.
        </Text>
      )}
    </View>
  );
}

// A quiet outline pill (the archive HeaderPill idiom). `danger` turns it Re-entry Red while
// the destructive "Start over" is armed for its second tap.
function HeaderAction({
  danger,
  label,
  onPress,
}: {
  danger?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" hitSlop={8} onPress={onPress}>
      {({ pressed }) => (
        <View
          style={[
            styles.pill,
            danger ? styles.pillDanger : null,
            pressed ? styles.pillPressed : null,
          ]}
        >
          <Text style={[font.label, { color: danger ? color.reentryRed : color.stardust }]}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { alignItems: "center", flexDirection: "row", gap: 8 },
  colophon: { gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  colophonLink: { color: color.eclipseGold },
  colophonText: { color: color.stardust },
  content: { paddingBottom: 24, paddingTop: 6 },
  flex: { flex: 1 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  nameplate: { color: color.starlightCream, fontSize: 22 },
  pill: {
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillDanger: { borderColor: color.reentryRed },
  pillPressed: { backgroundColor: color.goldVeil },
  railHeading: {
    color: color.stardust,
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  removeBtn: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  screen: { backgroundColor: color.deepField, flex: 1 },
  section: { paddingTop: 20 },
  sectionHeading: { color: color.starlightCream, paddingHorizontal: 16 },
  sectionSub: { color: color.stardust, paddingBottom: 8, paddingHorizontal: 16, paddingTop: 2 },
  stateText: { color: color.stardust, paddingHorizontal: 16 },
  tagline: { color: color.stardust, paddingHorizontal: 16, paddingTop: 8 },
});

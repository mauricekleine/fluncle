// The Mix tab — the set builder in the pocket, a port of the web `/mix` "Chain a set" tool.
// The app's standalone TOOL and its one surface built for a stranger rather than the crew: a
// free drum & bass mixing tool with no account (operator law — an account never gates or
// touches this feature). Name a few artists you like, pick something to open with, and the
// engine ranks what mixes in clean after it; the rail re-ranks after every add.
//
// A STEPPED FLOW (operator ruling 2026-07-12 — the web's one-page layout buried the openers
// below a full artist grid on a phone), driven by the chain plus one step flag:
//   1 taste   → the artist grid, with one footer CTA onward ("Pick an opener" — picking
//               zero artists is the sanctioned skip; step 2 still has search)
//   2 opener  → what to open with: the seeded artists' own tracks, and an archive search
//               ("Search tracks") for the reader who skipped or wasn't offered the right one
//   3 builder → the chain (numbered, last-item undo) + the rail ranked off its tail;
//               Share (the web URL — the link IS the state) + Start over
//
// The chain + taste persist device-local (mix.ts) and hydrate on mount; a cold start with a
// saved chain lands straight in the builder. The web route is gated by a self-lifting
// archive-depth check; the app deliberately does not check it (the mix ops are public + open
// in prod, and App Review must reach the tool) — see mix.ts.
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { type MixCandidate, type MixTrack } from "@fluncle/contracts";
import { useArchiveSearch, useMixableTracks, useMixOpeners } from "@/api/hooks";
import { orpc } from "@/api/orpc";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { NATIVE_TAB_BAR_HEIGHT } from "@/components/feed-card";
import { FindingRowSkeleton } from "@/components/finding-row";
import { KeyNotationToggle } from "@/components/key-notation-toggle";
import { MixRow } from "@/components/mix-row";
import { MixTastePicker } from "@/components/mix-taste-picker";
import { meFetch } from "@/lib/auth-client";
import { useMixChain } from "@/lib/mix";
import {
  buildMixShareUrl,
  MAX_TASTE_ARTISTS,
  mixReasonLabel,
  parseSetParam,
  parseTasteParam,
  searchHitToMixTrack,
  serializeSet,
  serializeTaste,
  setToken,
} from "@/lib/mix-set";
import { chainTokens } from "@/lib/mix-store";
import {
  adaptTrackToMixTrack,
  buildSaveSetBody,
  resolveChainFromTokens,
  SAVED_SETS_PATH,
} from "@/lib/saved-sets";
import { color, font } from "@/theme/tokens";

const TAGLINE =
  "Name a few artists you like. I rank what mixes in clean next, by key, tempo, and feel. Chain a set, then share it with the crew.";

export default function MixScreen() {
  const { add, chain, clear, load, ready, remove, setTaste, taste } = useMixChain();
  // The pre-chain step. Deliberately NOT persisted: a cold start always begins at taste
  // (or, with a saved chain, straight in the builder); after an undo-to-empty the reader
  // lands back on the opener step they came from.
  const [step, setStep] = useState<"opener" | "taste">("taste");
  const [confirmingClear, setConfirmingClear] = useState(false);

  const tokens = chainTokens(chain);
  const tail = tokens[tokens.length - 1];
  const { data: candidates = [] } = useMixableTracks({ exclude: tokens, idOrLogId: tail, taste });

  // Open-a-saved-set hydration: account.tsx hands the stored `?set=`/`?taste=` in as route
  // params (router.dismissTo → this tab). We resolve the tokens to chain snapshots and load
  // them, then CONSUME the params once so a later manual return to the tab never re-clobbers a
  // chain the reader has since built. See useSavedSetHydration.
  useSavedSetHydration(load);

  // The Save-set pill is shown ONLY to a signed-in reader (the never-gates law: a signed-out
  // Decks is byte-for-byte unchanged — no button, no upsell). Confirmed via `/api/me`, exactly
  // as the web ShareSetButton does, so a lapsed cookie never shows a broken control.
  const signedIn = useIsSignedIn();
  // A brief inline confirmation, the account modal's live-region grammar. Cleared on the next
  // save attempt so a stale line never lingers over a fresh action.
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");

  async function onSaveSet() {
    setSaving(true);
    setSaveNotice("");
    try {
      const bodyPayload = buildSaveSetBody(serializeSet(tokens), serializeTaste(taste));
      const response = await meFetch(SAVED_SETS_PATH, {
        body: JSON.stringify(bodyPayload),
        method: "POST",
      });
      // Copy reused verbatim from the web ShareSetButton's toast (the Chrome Rule).
      setSaveNotice(
        response.ok
          ? "Saved to your account. Find it under your findings."
          : "Couldn't save that set.",
      );
    } catch {
      setSaveNotice("Couldn't save that set.");
    } finally {
      setSaving(false);
    }
  }

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
  // arms it, the second clears and returns to the taste step.
  const onStartOver = () => {
    if (confirmingClear) {
      clear();
      setConfirmingClear(false);
      setStep("taste");
    } else {
      setConfirmingClear(true);
    }
  };

  const building = chain.length > 0;

  return (
    <View style={styles.screen}>
      <CosmosBackdrop />
      <SafeAreaView edges={["top"]} style={styles.flex}>
        {!ready ? (
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {Array.from({ length: 5 }, (_, i) => (
              <FindingRowSkeleton isLast={i === 4} key={i} />
            ))}
          </View>
        ) : building ? (
          <ScrollView
            contentContainerStyle={styles.content}
            contentInsetAdjustmentBehavior="automatic"
          >
            <View style={styles.header}>
              <Text style={[font.display, styles.nameplate]}>Chain a set</Text>
              <View style={styles.actions}>
                {signedIn ? (
                  <HeaderAction
                    disabled={saving}
                    label={saving ? "Saving…" : "Save set"}
                    onPress={() => void onSaveSet()}
                  />
                ) : null}
                <HeaderAction label="Share" onPress={onShare} />
                <HeaderAction
                  danger={confirmingClear}
                  label={confirmingClear ? "Tap again to clear" : "Start over"}
                  onPress={onStartOver}
                />
              </View>
            </View>
            {saveNotice ? (
              <Text accessibilityLiveRegion="polite" style={[font.body, styles.saveNotice]}>
                {saveNotice}
              </Text>
            ) : null}
            <ChainList chain={chain} onRemove={remove} />
            <Rail candidates={candidates} onAdd={add} />
          </ScrollView>
        ) : step === "taste" ? (
          <TasteStep onNext={() => setStep("opener")} onToggle={toggleTaste} taste={taste} />
        ) : (
          <OpenerStep onBack={() => setStep("taste")} onPick={add} taste={taste} />
        )}
      </SafeAreaView>
    </View>
  );
}

// STEP 1 — the taste seed: the artist grid with one CTA onward. The grid gets the whole
// screen (the openers no longer hide below its fold); the footer pill floats above the tab
// bar. Picking nothing and moving on is the sanctioned skip — step 2 always carries search.
function TasteStep({
  onNext,
  onToggle,
  taste,
}: {
  onNext: () => void;
  onToggle: (slug: string) => void;
  taste: string[];
}) {
  const insets = useSafeAreaInsets();
  // The iOS 26 floating pill hugs the bottom tighter than inset + bar-height implies (it
  // overlaps the home-indicator zone), so the naive sum leaves a dead band — the -24 was
  // eyeballed on-device against the pill's real top edge.
  const footerClearance = insets.bottom + NATIVE_TAB_BAR_HEIGHT - 24;

  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: footerClearance + 80 }]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={[font.display, styles.nameplate]}>Chain a set</Text>
        </View>
        <Text style={[font.body, styles.tagline]}>{TAGLINE}</Text>
        <MixTastePicker onToggle={onToggle} selected={taste} />
      </ScrollView>
      {/* The step CTA: a compact centered chip riding a fade-to-opaque warm-black band (the
          feed scrim's grammar), so it reads grounded to the bottom edge rather than a naked
          banner floating over the grid. The gradient is not pressable; the chip is. */}
      <LinearGradient
        // deepField (#090a0b) with alpha ramping in, so the band lands exactly on the
        // screen's own background and the grid fades out under the chip.
        colors={["rgba(9, 10, 11, 0)", "rgba(9, 10, 11, 0.92)", "rgba(9, 10, 11, 1)"]}
        locations={[0, 0.55, 1]}
        pointerEvents="box-none"
        style={[styles.footer, { paddingBottom: footerClearance }]}
      >
        <Pressable accessibilityRole="button" onPress={onNext}>
          {({ pressed }) => (
            <View style={[styles.cta, pressed ? styles.ctaPressed : null]}>
              <Text style={[font.label, styles.ctaText]}>
                {taste.length > 0 ? "Pick an opener" : "Skip — search a track"}
              </Text>
            </View>
          )}
        </Pressable>
      </LinearGradient>
    </View>
  );
}

// STEP 2 — what to open with. The seeded artists' own tracks lead (exact, verifiable — the
// list a stranger can trust at a glance); the archive search sits above them for the reader
// who skipped seeding or wasn't offered the right opener. While a query is live, results
// replace the openers; clearing it brings them back.
function OpenerStep({
  onBack,
  onPick,
  taste,
}: {
  onBack: () => void;
  onPick: (track: MixTrack) => void;
  taste: string[];
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const { data: openers = [], isPending: openersPending } = useMixOpeners(taste);

  // A keystroke is not a query (the archive screen's 180ms idiom).
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const searching = debounced.length >= 2;
  const { data: searchData, isPending: searchPending } = useArchiveSearch(
    searching ? debounced : undefined,
  );
  const hits = searchData?.results ?? [];

  const seeded = taste.length > 0;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
    >
      <Pressable accessibilityRole="button" hitSlop={8} onPress={onBack} style={styles.back}>
        <Ionicons color={color.stardust} name="chevron-back" size={16} />
        <Text style={[font.label, styles.backText]}>Change artists</Text>
      </Pressable>

      <View style={styles.sectionHeadingRow}>
        <Text style={[font.display, styles.nameplate]}>Open with</Text>
        <KeyNotationToggle />
      </View>
      <Text style={[font.body, styles.sectionSub]}>
        {seeded
          ? "Tracks by the artists you named. Pick one and I rank what mixes in after it."
          : "Find a track to open with. From there I rank what mixes in clean next."}
      </Text>

      <View style={styles.searchField}>
        <Ionicons color={color.stardust} name="search" size={16} />
        <TextInput
          accessibilityLabel="Search tracks"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search tracks"
          placeholderTextColor={color.stardust}
          returnKeyType="search"
          style={styles.searchInput}
          value={query}
        />
      </View>

      {searching ? (
        hits.length > 0 ? (
          <View style={styles.rows}>
            {hits.map((hit) => {
              const track = searchHitToMixTrack(hit);
              return (
                <MixRow
                  accessibilityLabel={`Open the set with ${track.title}`}
                  key={setToken(track)}
                  onPress={() => onPick(track)}
                  track={track}
                />
              );
            })}
          </View>
        ) : searchPending ? null : (
          <Text style={[font.body, styles.stateText]}>Nothing by that name out here.</Text>
        )
      ) : seeded ? (
        openers.length > 0 ? (
          <View style={styles.rows}>
            {openers.map((track) => (
              <MixRow
                accessibilityLabel={`Open the set with ${track.title}`}
                key={setToken(track)}
                onPress={() => onPick(track)}
                track={track}
              />
            ))}
          </View>
        ) : openersPending ? null : (
          // Trimmed from the web's line (which offers "or search for a track yourself" — here
          // the search field sits right above). The honest half is kept.
          <Text style={[font.body, styles.stateText]}>
            I have nothing on those artists I can place yet. Pick another few.
          </Text>
        )
      ) : null}
    </ScrollView>
  );
}

// STEP 3's chain: the set so far, cover-led and NUMBERED (a set is a sequence — the position
// column makes it read as a tracklist, distinct from the `+` candidate rows below). Last-item
// undo — only the final row carries a remove control (v1 is tight: no drag-reorder), so the
// reader peels the set back one at a time.
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
            position={index + 1}
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
    <View style={styles.railSection}>
      <View style={styles.railHeadingRow}>
        <Text style={[font.label, styles.railHeading]}>What mixes in next, ranked</Text>
        <KeyNotationToggle />
      </View>
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
// the destructive "Start over" is armed for its second tap; `disabled` greys it while a save
// is in flight.
function HeaderAction({
  danger,
  disabled,
  label,
  onPress,
}: {
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.pill,
            danger ? styles.pillDanger : null,
            pressed ? styles.pillPressed : null,
            disabled ? styles.pillDisabled : null,
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

// A one-shot `/api/me` probe — true once the server confirms a session. Mirrors the web
// ShareSetButton's gate exactly: a failed check leaves it false, so a signed-out (or
// lapsed-cookie) reader never sees the Save-set pill (the never-gates law).
function useIsSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let active = true;
    void meFetch("/api/me")
      .then((res) => res.json() as Promise<{ user: unknown }>)
      .then((body) => {
        if (active) {
          setSignedIn(Boolean(body.user));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return signedIn;
}

// Open-a-saved-set hydration. account.tsx hands the stored `?set=`/`?taste=` in as route
// params (router.dismissTo → this tab); we parse them, resolve each token to a chain snapshot
// through the public `get_track` op (the web's `getMixTracksByTokens` has no public twin — a
// token that can't resolve, e.g. an uncertified catalogue row, is dropped, mirroring that
// helper's order-preserving flatMap), load the chain, then CONSUME the params once so a later
// manual return to the tab never re-clobbers a chain the reader has since built.
function useSavedSetHydration(load: (chain: MixTrack[], taste: string[]) => void): void {
  const params = useLocalSearchParams<{ set?: string; taste?: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const consumedRef = useRef<string | null>(null);

  const setParam = typeof params.set === "string" ? params.set : "";
  const tasteParam = typeof params.taste === "string" ? params.taste : "";

  useEffect(() => {
    if (!setParam || consumedRef.current === setParam) {
      return;
    }
    consumedRef.current = setParam;

    const tokens = parseSetParam(setParam);
    const tasteSlugs = parseTasteParam(tasteParam);

    void (async () => {
      const resolved = await resolveChainFromTokens(tokens, async (token) => {
        try {
          const res = await queryClient.fetchQuery(
            orpc.get_track.queryOptions({ input: { idOrLogId: token } }),
          );
          return "track" in res ? adaptTrackToMixTrack(res.track) : null;
        } catch {
          return null;
        }
      });
      load(resolved, tasteSlugs);
      // Consume the params so re-focusing the tab later doesn't re-hydrate over a fresh chain.
      router.setParams({ set: "", taste: "" });
    })();
  }, [setParam, tasteParam, load, queryClient, router]);
}

const styles = StyleSheet.create({
  actions: { alignItems: "center", flexDirection: "row", gap: 8 },
  back: {
    alignItems: "center",
    flexDirection: "row",
    gap: 2,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  backText: { color: color.stardust },
  content: { paddingBottom: 24, paddingTop: 6 },
  cta: {
    alignItems: "center",
    backgroundColor: color.eclipseGold,
    borderRadius: 22,
    paddingHorizontal: 28,
    paddingVertical: 12,
  },
  ctaPressed: { backgroundColor: color.eclipseGlow },
  ctaText: { color: color.inkOnGold },
  flex: { flex: 1 },
  // The step CTA's bottom band: pinned to the screen edge, content fades out under it (One
  // Sun: the chip is the screen's single gold action).
  footer: {
    alignItems: "center",
    bottom: 0,
    left: 0,
    paddingTop: 48,
    position: "absolute",
    right: 0,
  },
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
  pillDisabled: { opacity: 0.5 },
  pillPressed: { backgroundColor: color.goldVeil },
  railHeading: { color: color.stardust },
  railHeadingRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  // Extra clearance over a plain section: the seam between "the set so far" and the
  // suggestions below it is the screen's most load-bearing boundary.
  railSection: { paddingTop: 28 },
  removeBtn: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  rows: { paddingTop: 12 },
  saveNotice: { color: color.stardust, paddingHorizontal: 16, paddingTop: 12 },
  screen: { backgroundColor: color.deepField, flex: 1 },
  searchField: {
    alignItems: "center",
    backgroundColor: color.tapeBlackFill,
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    color: color.starlightCream,
    flex: 1,
    fontFamily: font.body.fontFamily,
    padding: 0,
  },
  section: { paddingTop: 20 },
  sectionHeadingRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  sectionSub: { color: color.stardust, paddingHorizontal: 16, paddingTop: 4 },
  stateText: { color: color.stardust, paddingHorizontal: 16, paddingTop: 16 },
  tagline: { color: color.stardust, paddingHorizontal: 16, paddingTop: 8 },
});

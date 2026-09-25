import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
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
  parseTasteParam,
  searchHitToMixTrack,
  serializeSet,
  serializeTaste,
  setToken,
} from "@/lib/mix-set";
import { chainTokens } from "@/lib/mix-store";
import { buildSaveSetBody, resolveSavedSet, SAVED_SETS_PATH } from "@/lib/saved-sets";
import { color, font, radius } from "@/theme/tokens";

const TAGLINE =
  "Name a few artists you like. I rank what mixes in clean next, by key, tempo, and feel. Chain a set, then share it with the crew.";

export default function MixScreen() {
  const {
    add,
    adoptSourceSet,
    chain,
    clear,
    load,
    ready,
    remove,
    setTaste,
    sourceSetId,
    sourceSetName,
    taste,
  } = useMixChain();

  const [step, setStep] = useState<"opener" | "taste">("taste");
  const [confirmingClear, setConfirmingClear] = useState(false);

  const tokens = chainTokens(chain);
  const tail = tokens[tokens.length - 1];
  const { data: candidates = [], isPending: railPending } = useMixableTracks({
    exclude: tokens,
    idOrLogId: tail,
    taste,
  });

  useSavedSetHydration(load);

  const signedIn = useIsSignedIn();

  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  function openSaveDialog() {
    setSaveNotice("");
    setSaveName(sourceSetName ?? "");
    setSaveOpen(true);
  }

  async function onSaveSet(name: string) {
    setSaving(true);
    setSaveNotice("");
    try {
      const bodyPayload = buildSaveSetBody(name, serializeSet(tokens), serializeTaste(taste));
      const savedName = name.trim();

      let response: Response;
      if (sourceSetId) {
        response = await meFetch(`${SAVED_SETS_PATH}/${sourceSetId}`, {
          body: JSON.stringify(bodyPayload),
          method: "PATCH",
        });
        if (response.status === 404) {
          response = await meFetch(SAVED_SETS_PATH, {
            body: JSON.stringify(bodyPayload),
            method: "POST",
          });
          if (response.ok) {
            await adoptFromResponse(response, savedName);
          }
        } else if (response.ok) {
          adoptSourceSet({ id: sourceSetId, name: savedName });
        }
      } else {
        response = await meFetch(SAVED_SETS_PATH, {
          body: JSON.stringify(bodyPayload),
          method: "POST",
        });
        if (response.ok) {
          await adoptFromResponse(response, savedName);
        }
      }

      setSaveNotice(response.ok ? "Saved to your account." : "Couldn't save that set.");
      if (response.ok) {
        setSaveOpen(false);
      }
    } catch {
      setSaveNotice("Couldn't save that set.");
    } finally {
      setSaving(false);
    }
  }

  async function adoptFromResponse(response: Response, savedName: string) {
    const body = (await response.json()) as { savedSet?: { id?: string } };
    if (typeof body.savedSet?.id === "string") {
      adoptSourceSet({ id: body.savedSet.id, name: savedName });
    }
  }

  const toggleTaste = (slug: string) => {
    if (taste.includes(slug)) {
      setTaste(taste.filter((existing) => existing !== slug));
    } else if (taste.length < MAX_TASTE_ARTISTS) {
      setTaste([...taste, slug]);
    }
  };

  const onShare = () => {
    void Share.share({ url: buildMixShareUrl(tokens, taste) });
  };

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
                {signedIn ? <HeaderAction label="Save set" onPress={openSaveDialog} /> : null}
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
            <Rail candidates={candidates} onAdd={add} pending={railPending} />
          </ScrollView>
        ) : step === "taste" ? (
          <TasteStep onNext={() => setStep("opener")} onToggle={toggleTaste} taste={taste} />
        ) : (
          <OpenerStep onBack={() => setStep("taste")} onPick={add} taste={taste} />
        )}
      </SafeAreaView>
      <SaveSetModal
        busy={saving}
        chainLength={chain.length}
        name={saveName}
        onCancel={() => setSaveOpen(false)}
        onChangeName={setSaveName}
        onSave={() => void onSaveSet(saveName)}
        visible={saveOpen}
      />
    </View>
  );
}

function SaveSetModal({
  busy,
  chainLength,
  name,
  onCancel,
  onChangeName,
  onSave,
  visible,
}: {
  busy: boolean;
  chainLength: number;
  name: string;
  onCancel: () => void;
  onChangeName: (next: string) => void;
  onSave: () => void;
  visible: boolean;
}) {
  const canSave = chainLength > 0 && name.trim().length > 0 && !busy;

  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={visible}>
      <Pressable accessibilityLabel="Close" onPress={onCancel} style={styles.saveBackdrop}>
        <Pressable onPress={() => undefined} style={styles.saveCard}>
          <Text style={[font.display, styles.saveTitle]}>Save set</Text>
          <Text style={[font.label, styles.saveFieldLabel]}>Set name</Text>
          <TextInput
            accessibilityLabel="Set name"
            autoCapitalize="sentences"
            autoCorrect
            autoFocus
            maxLength={80}
            onChangeText={onChangeName}
            placeholder="Name this set"
            placeholderTextColor={color.stardust}
            returnKeyType="done"
            selectionColor={color.eclipseGold}
            style={styles.saveInput}
            value={name}
          />
          <View style={styles.saveActions}>
            <Pressable accessibilityRole="button" hitSlop={8} onPress={onCancel}>
              {({ pressed }) => (
                <View style={[styles.saveCancel, pressed ? styles.pillPressed : null]}>
                  <Text style={[font.label, { color: color.stardust }]}>Cancel</Text>
                </View>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              disabled={!canSave}
              hitSlop={8}
              onPress={onSave}
            >
              {({ pressed }) => (
                <View
                  style={[
                    styles.saveConfirm,
                    pressed ? styles.saveConfirmPressed : null,
                    canSave ? null : styles.pillDisabled,
                  ]}
                >
                  <Text style={[font.label, { color: color.inkOnGold }]}>
                    {busy ? "Saving…" : "Save set"}
                  </Text>
                </View>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

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

      <LinearGradient
        colors={["rgba(9, 10, 11, 0)", "rgba(9, 10, 11, 0.92)", "rgba(9, 10, 11, 1)"]}
        locations={[0, 0.55, 1]}
        pointerEvents="box-none"
        style={[styles.footer, { paddingBottom: footerClearance }]}
      >
        <Pressable accessibilityRole="button" onPress={onNext}>
          {({ pressed }) => (
            <View style={[styles.cta, pressed ? styles.ctaPressed : null]}>
              <Text style={[font.label, styles.ctaText]}>
                {taste.length > 0 ? "Pick an opener" : "Skip and search a track"}
              </Text>
            </View>
          )}
        </Pressable>
      </LinearGradient>
    </View>
  );
}

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
        ) : searchPending ? (
          <PendingRows />
        ) : (
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
        ) : openersPending ? (
          <PendingRows />
        ) : (
          <Text style={[font.body, styles.stateText]}>
            I have nothing on those artists I can place yet. Pick another few.
          </Text>
        )
      ) : null}
    </ScrollView>
  );
}

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

function PendingRows({ count = 3 }: { count?: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, i) => (
        <FindingRowSkeleton isLast={i === count - 1} key={i} />
      ))}
    </View>
  );
}

function Rail({
  candidates,
  onAdd,
  pending,
}: {
  candidates: MixCandidate[];
  onAdd: (track: MixTrack) => void;
  pending: boolean;
}) {
  return (
    <View style={styles.railSection}>
      <View style={styles.railHeadingRow}>
        <Text style={[font.label, styles.railHeading]}>What mixes in next, ranked</Text>
        <KeyNotationToggle />
      </View>
      {pending ? (
        <PendingRows />
      ) : candidates.length > 0 ? (
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

function useIsSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void meFetch("/api/v1/me")
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
    }, []),
  );

  return signedIn;
}

function useSavedSetHydration(
  load: (chain: MixTrack[], taste: string[], sourceSetId?: string, sourceSetName?: string) => void,
): void {
  const params = useLocalSearchParams<{
    savedSetId?: string;
    savedSetName?: string;
    set?: string;
    taste?: string;
  }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const consumedRef = useRef<string | null>(null);

  const setParam = typeof params.set === "string" ? params.set : "";
  const savedSetId = typeof params.savedSetId === "string" ? params.savedSetId : undefined;

  const savedSetName =
    typeof params.savedSetName === "string" && params.savedSetName
      ? params.savedSetName
      : undefined;
  const tasteParam = typeof params.taste === "string" ? params.taste : "";

  useEffect(() => {
    if (!setParam || consumedRef.current === setParam) {
      return;
    }
    consumedRef.current = setParam;

    const tasteSlugs = parseTasteParam(tasteParam);

    void (async () => {
      const resolved = await resolveSavedSet(setParam, async (set) => {
        const res = await queryClient.fetchQuery(
          orpc.list_set_tracks.queryOptions({ input: { set } }),
        );
        return res.tracks;
      });
      load(resolved, tasteSlugs, savedSetId, savedSetName);

      router.setParams({ savedSetId: "", savedSetName: "", set: "", taste: "" });
    })();
  }, [setParam, tasteParam, savedSetId, savedSetName, load, queryClient, router]);
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

  railSection: { paddingTop: 28 },
  removeBtn: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  rows: { paddingTop: 12 },
  saveActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end", marginTop: 20 },

  saveBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(9, 10, 11, 0.72)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  saveCancel: {
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  saveCard: {
    backgroundColor: color.sleeveBlack,
    borderColor: color.dustLine,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 20,
    width: "100%",
  },
  saveConfirm: {
    backgroundColor: color.eclipseGold,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  saveConfirmPressed: { backgroundColor: color.eclipseGlow },
  saveFieldLabel: { color: color.starlightCream, marginBottom: 8, marginTop: 16 },
  saveInput: {
    backgroundColor: color.tapeBlackFill,
    borderColor: color.dustLine,
    borderRadius: radius.md,
    borderWidth: 1,
    color: color.starlightCream,
    fontFamily: font.body.fontFamily,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  saveNotice: { color: color.stardust, paddingHorizontal: 16, paddingTop: 12 },
  saveTitle: { color: color.starlightCream, fontSize: 20 },
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

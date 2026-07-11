import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { type TrackSearchResult } from "@fluncle/contracts";
import { useSubmitTrack, useTrackSearch } from "@/api/hooks";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { classifySubmit, submitOutcomeCopy } from "@/lib/submit-fault";
import { color, font, radius } from "@/theme/tokens";

// The submit flow (roadmap: the app becomes a funnel, not a mirror). A crew member
// hands Fluncle a tune the same way the web dialog does: search Spotify → pick the
// match → send it for review, anonymous by design. It rides the SAME public
// `submit_track` contract the web posts; the server owns validation, the hourly
// rate limit, and status (a submission is a message in a bottle — no drafts, no
// history view). Presented as a modal off the archive header (the app's one place
// for global actions, next to Notifications). The honest result-state mapping is the pure,
// tested @/lib/submit-fault.

// Chrome converged with the web dialog (apps/web submit-track-dialog): the results
// heading, the note/contact labels, and the empty-query answer read identically
// across surfaces. Placeholder is a DELIBERATE divergence — the web's full-URL
// example truncates mid-URL in a 390px input, so the app keeps its shorter form.
const RESULTS_HEADING = "Select a match";
const SHORT_QUERY_HINT = "Enter a Spotify URL or track search.";
const SEARCH_FAILED_LINE = "Couldn't run that search. Give it another go in a sec.";
const NO_MATCHES_LINE = "Nothing came back for that. Try the artist and the title.";

export default function SubmitScreen() {
  const router = useRouter();
  const search = useTrackSearch();
  const submit = useSubmitTrack();

  const [query, setQuery] = useState("");
  const [shortQueryHint, setShortQueryHint] = useState(false);
  const [selected, setSelected] = useState<TrackSearchResult | undefined>(undefined);
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");

  const results = search.data?.results ?? [];
  const searchFailed = search.isError;
  const noMatches = search.isSuccess && results.length === 0;

  // One live announcement for the transient result-states so VoiceOver/TalkBack speak
  // them as they mount. Android reads the `accessibilityLiveRegion="polite"` nodes
  // below on its own; iOS has no live-region prop, so announce imperatively when the
  // spoken line changes. `submit.isError` wins — once a send has been attempted it is
  // the most recent event over a still-visible result list.
  const announcement = submit.isError
    ? submitOutcomeCopy[classifySubmit(submit.error)]
    : shortQueryHint
      ? SHORT_QUERY_HINT
      : searchFailed
        ? SEARCH_FAILED_LINE
        : noMatches
          ? NO_MATCHES_LINE
          : results.length > 0
            ? RESULTS_HEADING
            : undefined;

  useEffect(() => {
    if (Platform.OS === "ios" && announcement !== undefined) {
      AccessibilityInfo.announceForAccessibility(announcement);
    }
  }, [announcement]);

  function runSearch() {
    const trimmed = query.trim();

    // A too-short query ANSWERS (the web's model) rather than a silent no-op: the
    // Search control stays live and the empty-query line lands in the result slot.
    if (trimmed.length < 2) {
      setShortQueryHint(true);
      return;
    }

    setShortQueryHint(false);
    setSelected(undefined);
    submit.reset();
    search.mutate({ q: trimmed });
  }

  function sendSelected() {
    if (!selected) {
      return;
    }

    submit.mutate({
      album: selected.album,
      artists: selected.artists,
      artworkUrl: selected.artworkUrl,
      contact: contact.trim() || undefined,
      note: note.trim() || undefined,
      // The submission source enum is web | cli | ssh — no `mobile` value yet, so
      // the app rides `web` (a follow-up can add `mobile` server-side).
      source: "web",
      spotifyTrackId: selected.id,
      spotifyUrl: selected.spotifyUrl,
      title: selected.title,
    });
  }

  // Sent for review — the message is in the bottle. A quiet confirmation and a way out.
  if (submit.isSuccess) {
    return (
      <View style={{ flex: 1 }}>
        <CosmosBackdrop />
        <SafeAreaView style={{ flex: 1, gap: 16, justifyContent: "center", padding: 20 }}>
          <Text style={[font.display, { color: color.starlightCream, fontSize: 26 }]}>
            Logged. I&apos;ll give it a listen.
          </Text>
          <Text style={[font.body, { color: color.stardust }]}>
            If it gets an oof out of me, it lands in the archive with its own Log ID. Catch you out
            there, cosmonaut.
          </Text>
          <HeatButton label="Done" onPress={() => router.back()} />
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          {/* The modal dismisses by swipe; this fixed top-right control (Chrome Rule)
              keeps that dismissal discoverable and gives an explicit target for
              VoiceOver/TalkBack, never buried at the scroll tail. */}
          <View style={styles.topBar}>
            <Pressable
              accessibilityLabel="Cancel"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => router.back()}
              style={styles.cancel}
            >
              <Text style={[font.label, { color: color.stardust }]}>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={{ gap: 16, padding: 20 }}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[font.display, { color: color.starlightCream, fontSize: 26 }]}>
              Submit a track
            </Text>
            <Text style={[font.body, { color: color.stardust }]}>
              Search Spotify, pick the match, and send it for review.
            </Text>

            <View style={{ gap: 8 }}>
              <Text style={[font.label, { color: color.starlightCream }]}>
                Search or Spotify URL
              </Text>
              <TextInput
                accessibilityLabel="Search or Spotify URL"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                onChangeText={setQuery}
                onSubmitEditing={runSearch}
                placeholder="Camo & Crooked, or a Spotify link"
                placeholderTextColor={color.stardust}
                returnKeyType="search"
                selectionColor={color.eclipseGold}
                style={inputStyle}
                value={query}
              />
              <HeatButton
                disabled={search.isPending}
                icon={
                  search.isPending ? undefined : (
                    <Ionicons color={color.starlightCream} name="search" size={16} />
                  )
                }
                label={search.isPending ? "Searching…" : "Search"}
                onPress={runSearch}
                variant="outline"
              />
            </View>

            {shortQueryHint ? (
              <Text accessibilityLiveRegion="polite" style={[font.body, { color: color.stardust }]}>
                {SHORT_QUERY_HINT}
              </Text>
            ) : null}

            {searchFailed ? (
              <Text
                accessibilityLiveRegion="polite"
                style={[font.body, { color: color.reentryRed }]}
              >
                {SEARCH_FAILED_LINE}
              </Text>
            ) : null}

            {noMatches ? (
              <Text accessibilityLiveRegion="polite" style={[font.body, { color: color.stardust }]}>
                {NO_MATCHES_LINE}
              </Text>
            ) : null}

            {results.length > 0 ? (
              <View style={{ gap: 10 }}>
                <Text
                  accessibilityLiveRegion="polite"
                  style={[font.label, { color: color.starlightCream }]}
                >
                  {RESULTS_HEADING}
                </Text>
                {results.map((result) => (
                  <CandidateRow
                    key={result.id}
                    result={result}
                    selected={selected?.id === result.id}
                    onPress={() => setSelected(result)}
                  />
                ))}
              </View>
            ) : null}

            {selected ? (
              <View style={{ gap: 16 }}>
                <View style={{ gap: 8 }}>
                  <Text style={[font.label, { color: color.starlightCream }]}>Note</Text>
                  <TextInput
                    accessibilityLabel="Note"
                    maxLength={500}
                    multiline
                    onChangeText={setNote}
                    placeholder="Where'd you catch it? Why's it a banger?"
                    placeholderTextColor={color.stardust}
                    selectionColor={color.eclipseGold}
                    style={[inputStyle, { height: 88, textAlignVertical: "top" }]}
                    value={note}
                  />
                </View>
                <View style={{ gap: 8 }}>
                  <Text style={[font.label, { color: color.starlightCream }]}>Contact</Text>
                  <TextInput
                    accessibilityLabel="Contact"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={120}
                    onChangeText={setContact}
                    placeholder="A handle, so I can tip my hat if I log it"
                    placeholderTextColor={color.stardust}
                    selectionColor={color.eclipseGold}
                    style={inputStyle}
                    value={contact}
                  />
                </View>
                <HeatButton
                  label={submit.isPending ? "Sending…" : "Send for review"}
                  onPress={sendSelected}
                  disabled={submit.isPending}
                />
              </View>
            ) : null}

            {submit.isError ? (
              <Text
                accessibilityLiveRegion="polite"
                style={[font.body, { color: color.reentryRed }]}
              >
                {submitOutcomeCopy[classifySubmit(submit.error)]}
              </Text>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

// One Spotify candidate as a selectable row: artwork + Artist — Title. Selecting it
// washes the border Eclipse Gold (Ignition), the same tell the archive galaxy chips use.
function CandidateRow({
  onPress,
  result,
  selected,
}: {
  onPress: () => void;
  result: TrackSearchResult;
  selected: boolean;
}) {
  // The row layout lives on a plain inner View with a STATIC StyleSheet style,
  // mirroring finding-row.tsx: a Pressable style FUNCTION dropped flexDirection
  // under NativeWind in this app, so the Pressable stays layout-free and only the
  // heat/selection wash rides the pressed/selected conditionals.
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}>
      {({ pressed }) => (
        <View
          style={[
            styles.candidateRow,
            selected ? styles.candidateSelected : null,
            pressed && !selected ? styles.candidatePressed : null,
          ]}
        >
          <Image
            source={result.artworkUrl}
            style={styles.candidateArt}
            contentFit="cover"
            transition={200}
          />
          <View style={styles.candidateContent}>
            <Text style={[font.title, styles.candidateTitle]} numberOfLines={2}>
              {result.artists.join(", ")} — {result.title}
            </Text>
            {result.album ? (
              <Text style={[font.body, styles.candidateAlbum]} numberOfLines={1}>
                {result.album}
              </Text>
            ) : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cancel: { justifyContent: "center", minHeight: 44, paddingHorizontal: 8 },
  candidateAlbum: { color: color.stardust, fontSize: 13 },
  candidateArt: {
    borderColor: color.dustLine,
    borderRadius: radius.artwork,
    borderWidth: 1,
    height: 48,
    width: 48,
  },
  candidateContent: { flex: 1, gap: 3 },
  candidatePressed: { backgroundColor: color.goldVeil },
  candidateRow: {
    alignItems: "center",
    borderColor: color.dustLine,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 10,
  },
  candidateSelected: { backgroundColor: color.goldVeil, borderColor: color.eclipseGold },
  candidateTitle: { color: color.starlightCream, fontSize: 15 },
  topBar: { alignItems: "flex-end", paddingHorizontal: 20, paddingTop: 8 },
});

const inputStyle = {
  backgroundColor: color.sleeveBlack,
  borderColor: color.dustLine,
  borderRadius: radius.md,
  borderWidth: 1,
  color: color.starlightCream,
  fontSize: 16,
  paddingHorizontal: 12,
  paddingVertical: 10,
} as const;

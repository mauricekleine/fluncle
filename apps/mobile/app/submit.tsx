import { useState } from "react";
import {
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

export default function SubmitScreen() {
  const router = useRouter();
  const search = useTrackSearch();
  const submit = useSubmitTrack();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<TrackSearchResult | undefined>(undefined);
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");

  const results = search.data?.results ?? [];
  const searchFailed = search.isError;
  const noMatches = search.isSuccess && results.length === 0;

  function runSearch() {
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      return;
    }

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
                autoCapitalize="none"
                autoCorrect={false}
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
                label={search.isPending ? "Searching…" : "Search"}
                onPress={runSearch}
                variant="outline"
                disabled={search.isPending || query.trim().length < 2}
              />
            </View>

            {searchFailed ? (
              <Text style={[font.body, { color: color.reentryRed }]}>
                Couldn&apos;t run that search. Give it another go in a sec.
              </Text>
            ) : null}

            {noMatches ? (
              <Text style={[font.body, { color: color.stardust }]}>
                Nothing came back for that. Try the artist and the title.
              </Text>
            ) : null}

            {results.length > 0 ? (
              <View style={{ gap: 10 }}>
                <Text style={[font.label, { color: color.starlightCream }]}>Pick the match</Text>
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
                  <Text style={[font.label, { color: color.starlightCream }]}>Note (optional)</Text>
                  <TextInput
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
                  <Text style={[font.label, { color: color.starlightCream }]}>
                    Contact (optional)
                  </Text>
                  <TextInput
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
              <Text style={[font.body, { color: color.reentryRed }]}>
                {submitOutcomeCopy[classifySubmit(submit.error)]}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={() => router.back()}
              style={{ alignItems: "center", paddingVertical: 10 }}
            >
              <Text style={[font.label, { color: color.stardust }]}>Not now</Text>
            </Pressable>
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

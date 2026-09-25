import { useCallback, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
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
import { SafeAreaView } from "react-native-safe-area-context";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { authClient, meFetch } from "@/lib/auth-client";
import { mergeSavedWithAccount } from "@/lib/saved";
import { parseRemoteSetsList, type RemoteSavedSet, SAVED_SETS_PATH } from "@/lib/saved-sets";
import { API_BASE } from "@/config";
import { KeyNotationToggle } from "@/components/key-notation-toggle";
import { formatKey, syncKeyNotationFromAccount, useKeyNotation } from "@/lib/key-notation";
import { color, font, radius } from "@/theme/tokens";

type Me = {
  ok: true;
  user: null | {
    createdAt: string;
    displayUsername?: string;
    id: string;
    username?: string;
  };
};

export default function AccountScreen() {
  const router = useRouter();
  const [me, setMe] = useState<Me | undefined>(undefined);

  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const next = (await meFetch("/api/v1/me").then((res) => res.json())) as Me;
      setMe(next);
    } catch {
      setMe({ ok: true, user: null });
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const signedIn = !!me?.user;

  return (
    <View style={styles.flex}>
      <CosmosBackdrop />
      <SafeAreaView style={styles.flex}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.flex}
        >
          <View style={styles.topBar}>
            <Pressable
              accessibilityLabel="Close"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => router.back()}
              style={styles.close}
            >
              <Text style={[font.label, { color: color.stardust }]}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {me === undefined ? (
              <View style={styles.loading}>
                <ActivityIndicator color={color.stardust} />
              </View>
            ) : signedIn && me.user ? (
              <SignedInPanel
                notice={notice}
                onChanged={refresh}
                setNotice={setNotice}
                user={me.user}
              />
            ) : (
              <AuthPanel notice={notice} onSignedIn={refresh} setNotice={setNotice} />
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

function AuthPanel({
  notice,
  onSignedIn,
  setNotice,
}: {
  notice: string;
  onSignedIn: () => Promise<void>;
  setNotice: (message: string) => void;
}) {
  const [view, setView] = useState<"auth" | "reset">("auth");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    setNotice("");
    setBusy(true);

    try {
      const result =
        mode === "signup"
          ? await authClient.signUp.email({ email, name: username, password, username })
          : await authClient.signIn.username({ password, username });

      if (result.error) {
        setError(result.error.message ?? "Could not sign in.");
        return;
      }

      setNotice("Aboard. Your private Galaxy state is ready.");

      void mergeSavedWithAccount();
      await onSignedIn();

      void syncKeyNotationFromAccount({ force: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  if (view === "reset") {
    return (
      <ForgotPassword
        onBack={() => {
          setView("auth");
          setError("");
        }}
      />
    );
  }

  return (
    <View style={styles.stack}>
      <Text style={[font.display, styles.heading]}>Your place in the Galaxy</Text>
      <Text style={[font.body, styles.muted]}>Private progress, saved findings, and sets.</Text>

      {notice ? (
        <Text accessibilityLiveRegion="polite" style={[font.body, styles.muted]}>
          {notice}
        </Text>
      ) : null}

      <View style={styles.tabs}>
        <SwitchTab
          active={mode === "signin"}
          label="Sign in"
          onPress={() => {
            setMode("signin");
            setError("");
          }}
        />
        <SwitchTab
          active={mode === "signup"}
          label="Create account"
          onPress={() => {
            setMode("signup");
            setError("");
          }}
        />
      </View>

      {mode === "signup" ? (
        <Field
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          label="Email"
          onChangeText={setEmail}
          value={email}
        />
      ) : null}
      <Field
        autoCapitalize="none"
        autoComplete="username"
        label="Username"
        onChangeText={setUsername}
        value={username}
      />
      <Field
        autoCapitalize="none"
        autoComplete={mode === "signin" ? "current-password" : "new-password"}
        label="Password"
        onChangeText={setPassword}
        secureTextEntry
        value={password}
      />

      {mode === "signin" ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            setView("reset");
            setError("");
          }}
          style={styles.linkRow}
        >
          <Text style={[font.body, { color: color.stardust }]}>Forgot password?</Text>
        </Pressable>
      ) : null}

      <HeatButton
        disabled={busy}
        label={
          busy
            ? mode === "signup"
              ? "Creating account…"
              : "Signing in…"
            : mode === "signup"
              ? "Create private account"
              : "Sign in"
        }
        onPress={() => void submit()}
      />

      {error ? (
        <Text accessibilityLiveRegion="polite" style={[font.body, { color: color.reentryRed }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await authClient.requestPasswordReset({ email, redirectTo: `${API_BASE}/reset-password` });
    } catch {
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <View style={styles.stack}>
      <Text style={[font.display, styles.heading]}>Reset your password</Text>
      <Text style={[font.body, styles.muted]}>
        Enter your account email and I&rsquo;ll send a link to set a new password.
      </Text>
      <Field
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        label="Email"
        onChangeText={setEmail}
        value={email}
      />
      <HeatButton
        disabled={busy}
        label={busy ? "Sending…" : "Send reset link"}
        onPress={() => void submit()}
      />
      {sent ? (
        <Text accessibilityLiveRegion="polite" style={[font.body, styles.muted]}>
          If that account exists, a reset link is on its way.
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" hitSlop={8} onPress={onBack} style={styles.linkRow}>
        <Text style={[font.body, { color: color.stardust }]}>Back to sign in</Text>
      </Pressable>
    </View>
  );
}

function SignedInPanel({
  notice,
  onChanged,
  setNotice,
  user,
}: {
  notice: string;
  onChanged: () => Promise<void>;
  setNotice: (message: string) => void;
  user: NonNullable<Me["user"]>;
}) {
  const [busy, setBusy] = useState<"" | "delete" | "signout">("");
  const { arm, armed, disarm } = useArm("Tap again to delete your account, or cancel");
  const [error, setError] = useState("");

  const name = user.displayUsername ?? user.username ?? "cosmonaut";
  const joined = new Date(user.createdAt).toLocaleDateString();

  async function signOut() {
    setBusy("signout");
    setNotice("");
    try {
      await authClient.signOut();
      await onChanged();
    } finally {
      setBusy("");
    }
  }

  async function onDelete() {
    if (!armed) {
      arm();
      return;
    }

    setBusy("delete");
    setError("");
    try {
      const response = await meFetch("/api/v1/me/delete", { body: "{}", method: "POST" });
      if (!response.ok) {
        setError("Could not delete account. Try again in a moment.");
        disarm();
        return;
      }
      setNotice("Account deleted. Anonymous mode is still here.");
      await onChanged();
    } catch {
      setError("Could not delete account. Try again in a moment.");
      disarm();
    } finally {
      setBusy("");
    }
  }

  return (
    <View style={styles.stack}>
      <Text style={[font.display, styles.heading]}>Signed in as {name}</Text>
      <Text style={[font.body, styles.muted]}>
        Joined {joined}. Email stays private and never appears in public Fluncle surfaces.
      </Text>

      {notice ? (
        <Text accessibilityLiveRegion="polite" style={[font.body, styles.muted]}>
          {notice}
        </Text>
      ) : null}

      <SavedSets />

      <View style={styles.prefs}>
        <Text style={[font.label, styles.sectionHeading]}>Preferences</Text>
        <Text style={[font.body, styles.muted]}>
          How every key reads across Fluncle. Saved to your account, so it follows you to every
          device you sign in on.
        </Text>
        <Text style={[font.label, styles.prefsFieldLabel]}>Key notation</Text>

        <View style={styles.prefsToggle}>
          <KeyNotationToggle />
        </View>
        <NotationPreview />
      </View>

      <View style={styles.signOut}>
        <HeatButton
          disabled={busy !== ""}
          label={busy === "signout" ? "Signing out…" : "Sign out"}
          onPress={() => void signOut()}
          variant="outline"
        />
      </View>

      <View style={styles.danger}>
        <Text style={[font.label, styles.sectionHeading]}>Delete account</Text>
        <Text style={[font.body, styles.muted]}>
          Deletion removes private progress, saves, and sets, revokes sessions, and unlinks
          submissions from this account.
        </Text>
        <Pressable
          accessibilityLabel={armed ? "Tap again to delete your account" : "Delete account"}
          accessibilityRole="button"
          disabled={busy !== ""}
          onPress={() => void onDelete()}
        >
          {({ pressed }) => (
            <View style={[styles.dangerButton, pressed ? styles.dangerButtonPressed : null]}>
              <Text style={[font.label, styles.dangerLabel]}>
                {busy === "delete" ? "Deleting…" : armed ? "Tap again to delete" : "Delete account"}
              </Text>
            </View>
          )}
        </Pressable>
        {armed && busy !== "delete" ? (
          <Pressable
            accessibilityLabel="Cancel deleting your account"
            accessibilityRole="button"
            hitSlop={8}
            onPress={disarm}
            style={styles.dangerCancel}
          >
            <Text style={[font.label, styles.muted]}>Cancel</Text>
          </Pressable>
        ) : null}
        {error ? (
          <Text accessibilityLiveRegion="polite" style={[font.body, { color: color.reentryRed }]}>
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function NotationPreview() {
  const { notation } = useKeyNotation();

  return (
    <Text accessibilityLiveRegion="polite" style={[font.body, styles.muted]}>
      Keys read as {formatKey("G# minor", notation)}.
    </Text>
  );
}

function SavedSets() {
  const router = useRouter();

  const [sets, setSets] = useState<RemoteSavedSet[] | undefined>(undefined);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const body = await meFetch(SAVED_SETS_PATH).then((res) => res.json());
      setSets(parseRemoteSetsList(body));
    } catch {
      setSets([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openSet(set: RemoteSavedSet) {
    router.dismissTo({
      params: {
        savedSetId: set.id,
        savedSetName: set.name,
        set: set.setTokens,
        taste: set.taste ?? "",
      },
      pathname: "/mix",
    });
  }

  async function removeSet(set: RemoteSavedSet) {
    setMessage("");
    try {
      const response = await meFetch(`${SAVED_SETS_PATH}/${encodeURIComponent(set.id)}`, {
        method: "DELETE",
      });

      setMessage(response.ok ? "Set removed." : "Could not remove that set.");
      if (response.ok) {
        await load();
      }
    } catch {
      setMessage("Could not remove that set.");
    }
  }

  return (
    <View style={styles.setsSection}>
      <Text style={[font.label, styles.sectionHeading]}>Saved sets</Text>
      {sets === undefined ? null : sets.length === 0 ? (
        <Text style={[font.body, styles.muted]}>
          No saved sets yet. Chain one and save it here.
        </Text>
      ) : (
        <View style={styles.setList}>
          {sets.map((set) => (
            <SavedSetRow
              key={set.id}
              onOpen={() => openSet(set)}
              onRemove={() => void removeSet(set)}
              set={set}
            />
          ))}
        </View>
      )}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={[font.body, styles.muted]}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const ARM_TIMEOUT_MS = 4000;

function useArm(announcement: string): {
  arm: () => void;
  armed: boolean;
  disarm: () => void;
} {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) {
      return;
    }
    AccessibilityInfo.announceForAccessibility(announcement);
    const timer = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed, announcement]);

  return { arm: () => setArmed(true), armed, disarm: () => setArmed(false) };
}

function SavedSetRow({
  onOpen,
  onRemove,
  set,
}: {
  onOpen: () => void;
  onRemove: () => void;
  set: RemoteSavedSet;
}) {
  const { arm, armed, disarm } = useArm(`Tap again to delete ${set.name}, or cancel`);
  const touched = new Date(set.updatedAt).toLocaleDateString();

  return (
    <View style={styles.setRow}>
      <Pressable
        accessibilityHint="Opens this set on the Decks"
        accessibilityLabel={`Open ${set.name}`}
        accessibilityRole="button"
        onPress={onOpen}
        style={styles.setOpen}
      >
        <Text numberOfLines={1} style={[font.label, styles.setName]}>
          {set.name}
        </Text>
        <Text style={[font.numeric, styles.setDate]}>{touched}</Text>
      </Pressable>

      {armed ? (
        <View style={styles.setRowActions}>
          <Pressable
            accessibilityLabel={`Confirm deleting ${set.name}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => {
              onRemove();
              disarm();
            }}
          >
            <Text style={[font.label, styles.dangerLabel]}>Tap again</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Cancel deleting"
            accessibilityRole="button"
            hitSlop={8}
            onPress={disarm}
          >
            <Text style={[font.label, styles.muted]}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityLabel={`Delete ${set.name}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={arm}
        >
          <Text style={[font.label, styles.setDeleteGhost]}>Delete</Text>
        </Pressable>
      )}
    </View>
  );
}

function Field({
  autoCapitalize,
  autoComplete,
  keyboardType,
  label,
  onChangeText,
  secureTextEntry,
  value,
}: {
  autoCapitalize?: "characters" | "none" | "sentences" | "words";
  autoComplete?: React.ComponentProps<typeof TextInput>["autoComplete"];
  keyboardType?: React.ComponentProps<typeof TextInput>["keyboardType"];
  label: string;
  onChangeText: (next: string) => void;
  secureTextEntry?: boolean;
  value: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={[font.label, { color: color.starlightCream }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        autoCorrect={false}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        placeholderTextColor={color.stardust}
        secureTextEntry={secureTextEntry}
        selectionColor={color.eclipseGold}
        style={styles.input}
        value={value}
      />
    </View>
  );
}

function SwitchTab({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={{ bottom: 8, left: 4, right: 4, top: 8 }}
      onPress={onPress}
      style={[styles.tab, active ? styles.tabActive : null]}
    >
      <Text style={[font.label, { color: active ? color.eclipseGlow : color.stardust }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  close: { justifyContent: "center", minHeight: 44, paddingHorizontal: 8 },
  content: { gap: 16, padding: 20 },
  danger: {
    borderColor: color.dustLine,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 10,
    marginTop: 8,
    padding: 14,
  },
  dangerButton: {
    alignItems: "center",
    borderColor: color.reentryRed,
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  dangerButtonPressed: { backgroundColor: color.reentryRed },
  dangerCancel: { alignSelf: "center", padding: 6 },
  dangerLabel: { color: color.reentryRed },
  field: { gap: 8 },
  flex: { flex: 1 },
  heading: { color: color.starlightCream, fontSize: 26 },
  input: {
    backgroundColor: color.sleeveBlack,
    borderColor: color.dustLine,
    borderRadius: radius.md,
    borderWidth: 1,
    color: color.starlightCream,
    fontFamily: font.body.fontFamily,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  linkRow: { alignSelf: "flex-start", minHeight: 32, paddingVertical: 4 },
  loading: { paddingTop: 48 },
  muted: { color: color.stardust },
  prefs: { gap: 8, marginTop: 8 },
  prefsFieldLabel: { color: color.starlightCream, fontSize: 15, marginTop: 4 },
  prefsToggle: { alignSelf: "flex-start" },

  sectionHeading: { color: color.starlightCream, fontSize: 18 },
  setDate: { color: color.stardust, fontSize: 13 },
  setDeleteGhost: { color: color.stardust },
  setList: { gap: 8 },
  setName: { color: color.starlightCream, fontSize: 15 },
  setOpen: { flex: 1, gap: 2, paddingVertical: 4 },
  setRow: { alignItems: "center", flexDirection: "row", gap: 12 },
  setRowActions: { alignItems: "center", flexDirection: "row", gap: 14 },
  setsSection: { gap: 10, marginTop: 8 },
  signOut: { alignSelf: "flex-start" },
  stack: { gap: 16 },
  tab: {
    alignItems: "center",
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  tabActive: { backgroundColor: color.goldVeil, borderColor: color.eclipseGold },
  tabs: { flexDirection: "row", gap: 8 },
  topBar: { alignItems: "flex-end", paddingHorizontal: 20, paddingTop: 8 },
});

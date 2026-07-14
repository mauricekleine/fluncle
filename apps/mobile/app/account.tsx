import { useEffect, useState } from "react";
import {
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
import { API_BASE } from "@/config";
import { color, font, radius } from "@/theme/tokens";

// The /account modal (RFC: accounts in the pocket). An account is a QUIET, opt-in
// convenience — nothing anywhere gates on it, and anonymous behaviour everywhere is
// untouched. It rides the same public auth server the web does (public-auth.ts):
// email/password + the username plugin, the Expo cookie handshake, and the CSRF-guarded
// `/me` tier through `meFetch`. Presented as a modal off the archive header (the app's one
// place for global actions, beside Submit + Notifications), the visual sibling of submit.tsx.
//
// Copy is REUSED VERBATIM from the web account page (apps/web/src/routes/account.tsx) — one
// action, one label across surfaces (the Chrome Rule). Only the delete confirmation adopts
// the app's own two-tap arm idiom (the Decks "Start over" precedent), since the web's
// AlertDialog has no native analogue here.

// The current session, user-or-null — the shape GET /api/me returns (meResponse).
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
  // A top-level notice that outlives a view switch: the sign-in welcome and the post-delete
  // line both need to show against the view they land on.
  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const next = (await meFetch("/api/me").then((res) => res.json())) as Me;
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
          {/* The modal dismisses by swipe; this fixed control keeps that discoverable and
              gives VoiceOver/TalkBack an explicit target (submit.tsx's grammar). */}
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

// SIGNED OUT — sign in or create a private account, with a "Forgot password?" side view.
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
      await onSignedIn();
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

// The "Forgot password?" side view: collect the account email, ask the server to send a
// reset link, and always show the same enumeration-safe line (a send fault is swallowed —
// the confirmation must not reveal whether the address is on an account). The emailed link
// lands on the WEB /reset-password page.
function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await authClient.requestPasswordReset({ email, redirectTo: `${API_BASE}/reset-password` });
    } catch {
      // Swallow — the confirmation below is the same either way (enumeration-safe).
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

// SIGNED IN — the identity line, sign out, and the App-Review-mandated (5.1.1(v)) account
// deletion behind a two-tap arm (the app's destructive idiom; no AlertDialog on native).
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
  const [armed, setArmed] = useState(false);
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

  // Two-tap: the first tap arms, the second deletes (the Decks "Start over" precedent).
  async function onDelete() {
    if (!armed) {
      setArmed(true);
      return;
    }

    setBusy("delete");
    setError("");
    try {
      const response = await meFetch("/api/me/delete", { body: "{}", method: "POST" });
      if (!response.ok) {
        setError("Could not delete account.");
        setArmed(false);
        return;
      }
      setNotice("Account deleted. Anonymous mode is still here.");
      await onChanged();
    } catch {
      setError("Could not delete account.");
      setArmed(false);
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

      <HeatButton
        disabled={busy !== ""}
        label={busy === "signout" ? "Signing out…" : "Sign out"}
        onPress={() => void signOut()}
        variant="outline"
      />

      <View style={styles.danger}>
        <Text style={[font.label, { color: color.starlightCream }]}>Delete account</Text>
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
        {error ? (
          <Text accessibilityLiveRegion="polite" style={[font.body, { color: color.reentryRed }]}>
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// A labelled text input, the submit.tsx field grammar (label above a bordered input).
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

// The two-tab mode switch (the app's SegmentedControl-equivalent), styled off the archive
// FilterChip so it reads native and quiet.
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

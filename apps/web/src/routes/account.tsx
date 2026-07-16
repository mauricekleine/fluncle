import { createFileRoute, Link } from "@tanstack/react-router";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useState,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@fluncle/ui/components/alert-dialog";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fluncle/ui/components/tabs";
import { Textarea } from "@fluncle/ui/components/textarea";
import { siGoogle } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { GraphLink } from "@/components/graph-link";
import { KeyNotationToggle } from "@/components/key-notation-toggle";
import { authClient } from "@/lib/auth-client";
import { formatDateLong } from "@/lib/format";
import { siteUrl } from "@/lib/fluncle-links";
import { formatKey, syncKeyNotationFromAccount, useKeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";

type Me = {
  // Whether "Continue with Google" is live server-side. Gates the Google button so
  // it never renders dead. Present whether or not there is a session.
  googleEnabled: boolean;
  ok: true;
  user: null | {
    createdAt: string;
    displayUsername?: string;
    email: string;
    emailVerified: boolean;
    id: string;
    username?: string;
  };
};

type Progress = {
  collectedLogIds: string[];
  deaths: number;
  wins: number;
};

type CollectionItem = {
  artists: string[];
  firstCollectedAt: string;
  galaxyName?: string;
  galaxySlug?: string;
  imageUrl?: string;
  logId: string;
  title: string;
  trackId: string;
};

type GalaxyCompletion = {
  collected: number;
  name: string;
  slug: string;
  total: number;
};

type Collection = {
  collection: CollectionItem[];
  galaxies: GalaxyCompletion[];
};

type SavedFinding = {
  artists: string[];
  logId: string;
  note?: string;
  savedAt: string;
  title: string;
  trackId: string;
};

type Submission = {
  artists: string[];
  createdAt: string;
  id: string;
  status: string;
  title: string;
};

type SavedSet = {
  createdAt: string;
  id: string;
  name: string;
  setTokens: string;
  taste?: string;
  updatedAt: string;
};

type AccountState = {
  collection: Collection | undefined;
  csrfToken: string;
  me: Me | undefined;
  progress: Progress | undefined;
  saved: SavedFinding[];
  sets: SavedSet[];
  submissions: Submission[];
};

type AccountAction =
  | { me: Me; type: "signedOut" }
  | {
      collection: Collection;
      csrfToken: string;
      me: Me;
      progress: Progress;
      saved: SavedFinding[];
      sets: SavedSet[];
      submissions: Submission[];
      type: "loaded";
    };

const initialAccountState: AccountState = {
  collection: undefined,
  csrfToken: "",
  me: undefined,
  progress: undefined,
  saved: [],
  sets: [],
  submissions: [],
};

function accountReducer(state: AccountState, action: AccountAction): AccountState {
  switch (action.type) {
    case "signedOut":
      return { ...initialAccountState, me: action.me };
    case "loaded":
      return {
        collection: action.collection,
        csrfToken: action.csrfToken,
        me: action.me,
        progress: action.progress,
        saved: action.saved,
        sets: action.sets,
        submissions: action.submissions,
      };
    default:
      return state;
  }
}

/** The three signed-in panels. Absent from the URL = the Galaxy (the default view). */
type AccountTab = "galaxy" | "saves" | "settings";

function parseAccountTab(value: unknown): AccountTab | undefined {
  return value === "saves" || value === "settings" ? value : undefined;
}

// oxlint-disable-next-line sort-keys -- TanStack's canonical option order (validateSearch feeds the rest).
export const Route = createFileRoute("/account")({
  validateSearch: (search: Record<string, unknown>): { tab?: AccountTab } => ({
    tab: parseAccountTab(search.tab),
  }),
  head: () => ({
    links: [{ href: `${siteUrl}/account`, rel: "canonical" }],
    meta: [
      { title: "Your place in the Galaxy" },
      {
        content:
          "Private Fluncle account settings, Galaxy progress, saved findings, and submissions.",
        name: "description",
      },
    ],
  }),
  component: AccountPage,
});

function AccountPage() {
  const [{ collection, csrfToken, me, progress, saved, sets, submissions }, dispatch] = useReducer(
    accountReducer,
    initialAccountState,
  );
  const [message, setMessage] = useState("");
  const signedIn = !!me?.user;

  async function refresh() {
    const nextMe = (await fetch("/api/me").then((res) => res.json())) as Me;

    if (!nextMe.user) {
      dispatch({ me: nextMe, type: "signedOut" });
      return;
    }

    const [
      progressResponse,
      collectionResponse,
      savedResponse,
      setsResponse,
      submissionsResponse,
      csrfResponse,
    ] = await Promise.all([
      fetch("/api/me/galaxy-progress").then((res) => res.json() as Promise<Progress>),
      fetch("/api/me/galaxy-collection").then((res) => res.json() as Promise<Collection>),
      fetch("/api/me/saved-findings").then(
        (res) => res.json() as Promise<{ savedFindings?: SavedFinding[] }>,
      ),
      fetch("/api/me/saved-sets").then((res) => res.json() as Promise<{ savedSets?: SavedSet[] }>),
      fetch("/api/me/submissions").then(
        (res) => res.json() as Promise<{ submissions?: Submission[] }>,
      ),
      fetch("/api/me/csrf").then((res) => res.json() as Promise<{ csrfToken?: string }>),
    ]);

    dispatch({
      collection: {
        collection: collectionResponse.collection ?? [],
        galaxies: collectionResponse.galaxies ?? [],
      },
      csrfToken: csrfResponse.csrfToken ?? "",
      me: nextMe,
      progress: progressResponse as Progress,
      saved: (savedResponse.savedFindings ?? []) as SavedFinding[],
      sets: (setsResponse.savedSets ?? []) as SavedSet[],
      submissions: (submissionsResponse.submissions ?? []) as Submission[],
      type: "loaded",
    });
  }

  useEffect(() => {
    void refresh();
  }, []);

  const name = me?.user?.displayUsername ?? me?.user?.username ?? "cosmonaut";

  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:p-8">
      <article className="home-plate account-plate mx-auto my-6 w-full max-w-3xl sm:my-8">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">Your place in the Galaxy</h1>
            <p className="home-tagline">Private progress, saved findings, and submissions.</p>
          </div>
          <Link
            className="text-sm font-semibold text-muted-foreground hover:text-accent-foreground"
            to="/"
          >
            Back to findings
          </Link>
        </header>

        {me === undefined ? (
          <p className="account-muted">Checking the manifest…</p>
        ) : signedIn && me.user ? (
          <SignedInAccount
            collection={collection}
            message={message}
            name={name}
            progress={progress}
            refresh={refresh}
            saved={saved}
            csrfToken={csrfToken}
            setMessage={setMessage}
            sets={sets}
            submissions={submissions}
            user={me.user}
          />
        ) : (
          <AuthForms
            googleEnabled={me.googleEnabled}
            message={message}
            refresh={refresh}
            setMessage={setMessage}
          />
        )}
      </article>
    </main>
  );
}

function AuthForms({
  googleEnabled,
  message,
  refresh,
  setMessage,
}: {
  googleEnabled: boolean;
  message: string;
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const [view, setView] = useState<"auth" | "reset">("auth");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    setBusy(true);

    try {
      const result =
        mode === "signup"
          ? await authClient.signUp.email({
              // Where the email-verification link lands the user once they click it
              // (Better Auth signs them in first via autoSignInAfterVerification).
              callbackURL: "/account",
              email,
              name: username,
              password,
              username,
            })
          : await authClient.signIn.username({
              password,
              username,
            });

      if (result.error) {
        setMessage(result.error.message ?? "Could not sign in.");
        return;
      }

      await refresh();
      setMessage(
        mode === "signup"
          ? "Aboard. I sent a link to verify your email. You're already signed in, so there's no rush."
          : "Aboard. Your private Galaxy state is ready.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  // "Continue with Google" — a full-page OAuth redirect to Google, back to /account.
  // On success the browser navigates away (no busy reset needed); on a synchronous
  // failure to start the flow, surface it and re-enable the form.
  async function continueWithGoogle() {
    setMessage("");
    setBusy(true);

    try {
      await authClient.signIn.social({ callbackURL: "/account", provider: "google" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not continue with Google.");
      setBusy(false);
    }
  }

  if (view === "reset") {
    return (
      <ForgotPasswordForm
        onBack={() => {
          setView("auth");
          setMessage("");
        }}
      />
    );
  }

  return (
    <form className="account-stack" onSubmit={(event) => void submit(event)}>
      <Tabs
        value={mode}
        onValueChange={(value) => {
          setMode(value as "signin" | "signup");
          setMessage("");
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger value="signin">Sign in</TabsTrigger>
          <TabsTrigger value="signup">Create account</TabsTrigger>
        </TabsList>
      </Tabs>
      {googleEnabled ? (
        <>
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => void continueWithGoogle()}
            type="button"
            variant="outline"
          >
            <BrandIcon className="size-4" icon={siGoogle} />
            Continue with Google
          </Button>
          <p className="account-muted text-center text-xs">or use your email</p>
        </>
      ) : null}
      {mode === "signup" ? (
        <Field label="Email">
          <Input
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
      ) : null}
      <Field label="Username">
        <Input
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field label="Password">
        <Input
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      {mode === "signin" ? (
        <button
          className="self-start text-sm text-muted-foreground hover:text-accent-foreground"
          onClick={() => {
            setView("reset");
            setMessage("");
          }}
          type="button"
        >
          Forgot password?
        </button>
      ) : null}
      <Button disabled={busy} type="submit">
        {busy
          ? mode === "signup"
            ? "Creating account…"
            : "Signing in…"
          : mode === "signup"
            ? "Create private account"
            : "Sign in"}
      </Button>
      {message ? (
        <p aria-live="polite" className="account-muted">
          {message}
        </p>
      ) : null}
    </form>
  );
}

// The "Forgot password?" panel: collect the account email and ask Better Auth to
// send a reset link (its `/request-password-reset` endpoint, delivered by the
// server's `sendResetPassword` → Resend). The confirmation is deliberately identical
// whether or not the email is on an account — email-enumeration-safe — so the send
// error (if any) is swallowed and the same line always shows.
function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);

    try {
      await authClient.requestPasswordReset({
        email,
        redirectTo: `${siteUrl}/reset-password`,
      });
    } catch {
      // Swallow — the confirmation below is the same either way (enumeration-safe).
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <form className="account-stack" onSubmit={(event) => void submit(event)}>
      <div>
        <h2>Reset your password</h2>
        <p className="account-muted">
          Enter your account email and I&rsquo;ll send a link to set a new password.
        </p>
      </div>
      <Field label="Email">
        <Input
          autoComplete="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Button disabled={busy} type="submit">
        {busy ? "Sending…" : "Send reset link"}
      </Button>
      {sent ? (
        <p aria-live="polite" className="account-muted">
          If that account exists, a reset link is on its way.
        </p>
      ) : null}
      <button
        className="self-start text-sm text-muted-foreground hover:text-accent-foreground"
        onClick={onBack}
        type="button"
      >
        Back to sign in
      </button>
    </form>
  );
}

function SignedInAccount({
  collection,
  csrfToken,
  message,
  name,
  progress,
  refresh,
  saved,
  setMessage,
  sets,
  submissions,
  user,
}: {
  collection?: Collection;
  csrfToken: string;
  message: string;
  name: string;
  progress?: Progress;
  refresh: () => Promise<void>;
  saved: SavedFinding[];
  setMessage: (message: string) => void;
  sets: SavedSet[];
  submissions: Submission[];
  user: NonNullable<Me["user"]>;
}) {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [setsMessage, setSetsMessage] = useState("");
  const joined = useMemo(() => formatDateLong(user.createdAt), [user.createdAt]);

  async function signOut() {
    await authClient.signOut();
    await refresh();
  }

  return (
    <div className="account-stack">
      <section className="account-section">
        <div className="account-row account-identity">
          <div>
            <p className="account-kicker">Signed in as {name}</p>
            <p className="account-muted">
              Joined {joined}. Email stays private and never appears in public Fluncle surfaces.
            </p>
          </div>
          <Button onClick={() => void signOut()} size="sm" type="button" variant="ghost">
            Sign out
          </Button>
        </div>
        {message ? (
          <p aria-live="polite" className="account-muted">
            {message}
          </p>
        ) : null}
      </section>

      <Tabs
        onValueChange={(value) => {
          void navigate({
            replace: true,
            search: { tab: parseAccountTab(value) },
          });
        }}
        value={tab ?? "galaxy"}
      >
        <TabsList className="w-full">
          <TabsTrigger value="galaxy">Galaxy</TabsTrigger>
          <TabsTrigger value="saves">Saves</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent className="account-tab-panel" value="galaxy">
          <section className="account-section">
            <div className="account-grid">
              <Metric label="Lifetime logs" value={progress?.collectedLogIds.length ?? 0} />
              <Metric label="Runs home" value={progress?.wins ?? 0} />
              <Metric label="Tows" value={progress?.deaths ?? 0} />
            </div>
            <p className="account-muted">
              Your Galaxy game record: stars logged, runs flown home, and tows back to Earth after a
              dry tank.
            </p>
          </section>
          <CollectionSection collection={collection} />
        </TabsContent>

        <TabsContent className="account-tab-panel" value="saves">
          <section className="account-section">
            <h2>Saved findings</h2>
            <ListEmpty items={saved} empty="No saved findings yet.">
              {saved.map((finding) => (
                <li key={finding.trackId}>
                  <Link to="/log/$logId" params={{ logId: finding.logId }}>
                    {finding.artists.join(", ")} — {finding.title}
                  </Link>
                </li>
              ))}
            </ListEmpty>
          </section>

          <section className="account-section">
            <h2>Saved sets</h2>
            <ListEmpty items={sets} empty="No saved sets yet. Chain one on /mix and save it here.">
              {sets.map((set) => (
                <SavedSetRow
                  csrfToken={csrfToken}
                  key={set.id}
                  refresh={refresh}
                  set={set}
                  setMessage={setSetsMessage}
                />
              ))}
            </ListEmpty>
            {setsMessage ? (
              <p aria-live="polite" className="account-muted">
                {setsMessage}
              </p>
            ) : null}
          </section>

          <section className="account-section">
            <h2>Your submissions</h2>
            <ListEmpty items={submissions} empty="No submissions from this account yet.">
              {submissions.map((submission) => (
                <li key={submission.id}>
                  {submission.artists.join(", ")} — {submission.title}{" "}
                  <span>{submission.status}</span>
                </li>
              ))}
            </ListEmpty>
          </section>
        </TabsContent>

        <TabsContent className="account-tab-panel" value="settings">
          <SettingsPanel
            csrfToken={csrfToken}
            refresh={refresh}
            setMessage={setMessage}
            user={user}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The collection browser: the named galaxies as a map of the archive with the
 * user's progress written into it. Every NAMED galaxy renders a completion line
 * ("4 of 17 logged"); a finished galaxy earns the page's one gold note. Collected
 * findings whose galaxy is not yet named group under "Uncharted" — present, never
 * introduced (they get a coordinate and a date, no galaxy name until the operator
 * names one). Dates are the user's own first-collected moments, not the archive's.
 */
function CollectionSection({ collection }: { collection?: Collection }) {
  if (!collection) {
    return (
      <section className="account-section">
        <h2>Collection</h2>
        <p className="account-muted">Reading your log…</p>
      </section>
    );
  }

  const bySlug = new Map<string, CollectionItem[]>();
  const ungrouped: CollectionItem[] = [];

  for (const item of collection.collection) {
    if (item.galaxySlug) {
      const group = bySlug.get(item.galaxySlug) ?? [];

      group.push(item);
      bySlug.set(item.galaxySlug, group);
    } else {
      ungrouped.push(item);
    }
  }

  if (collection.collection.length === 0 && collection.galaxies.length === 0) {
    return (
      <section className="account-section">
        <h2>Collection</h2>
        <p className="account-muted">
          No stars logged yet. Every star you reach in the Galaxy lands here, with the date you
          reached it.
        </p>
        <Link className="account-collection-cta" to="/galaxy">
          Fly the Galaxy
        </Link>
      </section>
    );
  }

  return (
    <section className="account-section">
      <h2>Collection</h2>
      <p className="account-muted">
        Every star you reach in the Galaxy is logged here for good, with the date you reached it.
      </p>
      {collection.galaxies.map((galaxy) => (
        <CollectionGroup
          complete={galaxy.total > 0 && galaxy.collected >= galaxy.total}
          count={`${galaxy.collected} of ${galaxy.total} logged`}
          items={bySlug.get(galaxy.slug) ?? []}
          key={galaxy.slug}
          name={galaxy.name}
          slug={galaxy.slug}
        />
      ))}
      {ungrouped.length > 0 ? (
        // Findings whose galaxy is not yet named (or whose galaxy retired) render
        // UNHEADED — coordinate, cover, and date, no galaxy clause, no heading, no
        // count. An unnamed tier is never introduced and never given a noun; until
        // the map is fully named this block IS the whole collection.
        <ul className="account-list account-collection-unheaded">
          {ungrouped.map((item) => (
            <CollectionRow item={item} key={item.trackId} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CollectionGroup({
  complete,
  count,
  items,
  name,
  slug,
}: {
  complete: boolean;
  count: string;
  items: CollectionItem[];
  name: string;
  slug: string;
}) {
  return (
    <div className="account-collection-group">
      <div className="account-collection-heading">
        <h3>
          <GraphLink kind="galaxy" slug={slug}>
            {name}
          </GraphLink>
        </h3>
        <span className={complete ? "account-collection-complete" : undefined}>
          {complete ? `All ${items.length} logged` : count}
        </span>
      </div>
      {items.length > 0 ? (
        <ul className="account-list">
          {items.map((item) => (
            <CollectionRow item={item} key={item.trackId} />
          ))}
        </ul>
      ) : (
        <p className="account-muted">No stars logged here yet.</p>
      )}
    </div>
  );
}

function CollectionRow({ item }: { item: CollectionItem }) {
  return (
    <li className="account-collection-row">
      {item.imageUrl ? (
        <img
          alt=""
          className="account-collection-thumb"
          height={40}
          loading="lazy"
          src={albumCoverAtSize(item.imageUrl, "small")}
          width={40}
        />
      ) : (
        <span aria-hidden className="account-collection-thumb" />
      )}
      <span className="account-collection-body">
        <Link to="/log/$logId" params={{ logId: item.logId }}>
          {item.artists.join(", ")} — {item.title}
        </Link>
        <span className="account-collection-meta">
          <span className="account-collection-logid">{item.logId}</span> · First logged{" "}
          {formatDateLong(item.firstCollectedAt)}
        </span>
      </span>
    </li>
  );
}

/**
 * The Settings tab: preferences, the profile form, the CLI pointer, and — at the
 * bottom, deliberately last — export and deletion. Same behaviors as before the
 * tab split; only the residence changed.
 */
function SettingsPanel({
  csrfToken,
  refresh,
  setMessage,
  user,
}: {
  csrfToken: string;
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
  user: NonNullable<Me["user"]>;
}) {
  const [username, setUsername] = useState(user.username ?? "");
  const [displayUsername, setDisplayUsername] = useState(
    user.displayUsername ?? user.username ?? "",
  );
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [emailMessage, setEmailMessage] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [dangerMessage, setDangerMessage] = useState("");
  const [dangerBusy, setDangerBusy] = useState<"" | "delete" | "export">("");
  const [exportText, setExportText] = useState("");
  const { notation } = useKeyNotation();

  // This panel only mounts for a signed-in user, so force the key-notation store to
  // adopt the profile's stored choice — covering a sign-in mid-session (the one-time
  // sync may have already run anonymously). Toggling the control below then mirrors
  // the change back to the profile.
  useEffect(() => {
    void syncKeyNotationFromAccount({ force: true });
  }, []);

  // Resend the verification link to the signed-in user's own email. The confirmation
  // is deliberately uniform (never leaks whether the address is already verified).
  async function resendVerification() {
    setEmailBusy(true);
    setEmailMessage("");

    try {
      await authClient.sendVerificationEmail({ callbackURL: "/account", email: user.email });
      setEmailMessage("Sent. Check your inbox for the verification link.");
    } catch {
      setEmailMessage("Could not send right now. Try again in a moment.");
    } finally {
      setEmailBusy(false);
    }
  }

  async function patchProfile(event: React.FormEvent) {
    event.preventDefault();
    setSettingsBusy(true);

    try {
      const response = await fetch("/api/me/profile", {
        body: JSON.stringify({ displayUsername, username }),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "PATCH",
      });

      setSettingsMessage(
        response.ok
          ? "Username updated."
          : ((await response.json()) as { message: string }).message,
      );
      await refresh();
    } finally {
      setSettingsBusy(false);
    }
  }

  async function exportData() {
    setDangerBusy("export");
    setDangerMessage("");

    try {
      const response = await fetch("/api/me/export", {
        body: "{}",
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "POST",
      });
      const data = (await response.json()) as { export?: unknown };

      setExportText(JSON.stringify(data.export ?? data, null, 2));
    } catch {
      setDangerMessage("Could not export right now. Try again in a moment.");
    } finally {
      setDangerBusy("");
    }
  }

  async function deleteData() {
    setDangerBusy("delete");

    try {
      const response = await fetch("/api/me/delete", {
        body: "{}",
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "POST",
      });

      setMessage(
        response.ok
          ? "Account deleted. Anonymous mode is still here."
          : "Could not delete account.",
      );
      await refresh();
    } finally {
      setDangerBusy("");
    }
  }

  return (
    <>
      {user.username ? null : (
        // A Google arrival has no username yet. A quiet, non-blocking nudge toward
        // the Username field just below — nothing on the account depends on it.
        <section className="account-section">
          <h2>Claim a username</h2>
          <p className="account-muted">
            You&rsquo;re in, but you haven&rsquo;t claimed a username yet. Pick one below so your
            saves and submissions have a name on them. No rush, and you can change it later.
          </p>
        </section>
      )}

      <section className="account-section">
        <h2>Preferences</h2>
        <p className="account-muted">
          How every key reads across Fluncle. Saved to your account, so it follows you to every
          device you sign in on.
        </p>
        <div className="account-field">
          <span className="text-sm font-medium">Key notation</span>
          <KeyNotationToggle />
          <p aria-live="polite" className="account-muted">
            Keys read as {formatKey("G# minor", notation)}.
          </p>
        </div>
      </section>

      <form className="account-section" onSubmit={(event) => void patchProfile(event)}>
        <h2>Settings</h2>
        <Field label="Username">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field label="Display name">
          <Input
            value={displayUsername}
            onChange={(event) => setDisplayUsername(event.target.value)}
          />
        </Field>
        <div className="account-row">
          <Button disabled={settingsBusy} type="submit" variant="outline">
            {settingsBusy ? "Updating…" : "Update settings"}
          </Button>
          {settingsMessage ? (
            <p aria-live="polite" className="account-muted">
              {settingsMessage}
            </p>
          ) : null}
        </div>
      </form>

      <section className="account-section">
        <h2>Email</h2>
        <p className="account-muted">
          {user.email} · {user.emailVerified ? "verified" : "not verified yet"}
        </p>
        {user.emailVerified ? null : (
          <>
            <p className="account-muted">
              Nothing is locked without it. Verifying just keeps the door yours.
            </p>
            <div className="account-row">
              <Button
                disabled={emailBusy}
                onClick={() => void resendVerification()}
                type="button"
                variant="outline"
              >
                {emailBusy ? "Sending…" : "Resend verification email"}
              </Button>
              {emailMessage ? (
                <p aria-live="polite" className="account-muted">
                  {emailMessage}
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>

      <section className="account-section">
        <h2>Link the CLI</h2>
        <p className="account-muted">
          Got the <code>fluncle</code> CLI? Run <code>fluncle login</code> in your terminal to link
          this device and sync your Galaxy from the command line. I&rsquo;ll send you back here to
          approve it.
        </p>
      </section>

      <section className="account-section account-danger">
        <h2>Export and deletion</h2>
        <p className="account-muted">
          Export includes private progress, saved findings, saved sets, and signed-in submissions.
          Deletion removes private progress, saves, and sets, revokes sessions, and unlinks
          submissions from this account.
        </p>
        <div className="account-row">
          <Button
            disabled={dangerBusy !== ""}
            type="button"
            variant="outline"
            onClick={() => void exportData()}
          >
            {dangerBusy === "export" ? "Exporting…" : "Export data"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button disabled={dangerBusy !== ""} type="button" variant="destructive">
                  {dangerBusy === "delete" ? "Deleting…" : "Delete account"}
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this account?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes your private progress, saves, and sets, revokes your sessions, and
                  unlinks submissions from this account. It cannot be undone. The archive stays, and
                  anonymous mode is still here.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void deleteData()}>
                  Delete account
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {dangerMessage ? (
          <p aria-live="polite" className="account-muted">
            {dangerMessage}
          </p>
        ) : null}
        {exportText ? (
          <Textarea readOnly className="min-h-48 font-mono text-xs" value={exportText} />
        ) : null}
      </section>
    </>
  );
}

// One saved set: open it back on /mix (the stored tokens + taste handed to the route's
// loader; the set's `id`/`name` ride as `from`/`fromName` so /mix adopts it as the STABLE
// REFERENCE — every save there PATCHes THIS set), rename it, or delete it (behind the same
// confirm-dialog vocabulary as account deletion — one grammar for destructive acts). Rename +
// delete are plain CSRF fetches then a refresh, the page's established mutation shape.
function SavedSetRow({
  csrfToken,
  refresh,
  set,
  setMessage,
}: {
  csrfToken: string;
  refresh: () => Promise<void>;
  set: SavedSet;
  setMessage: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(set.name);

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch(`/api/me/saved-sets/${set.id}`, {
      body: JSON.stringify({ name }),
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "PATCH",
    });

    setEditing(false);
    setMessage(response.ok ? "Set renamed." : "Could not rename that set.");
    await refresh();
  }

  async function remove() {
    const response = await fetch(`/api/me/saved-sets/${set.id}`, {
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "DELETE",
    });

    setMessage(response.ok ? "Set removed." : "Could not remove that set.");
    await refresh();
  }

  if (editing) {
    return (
      <li>
        <form className="account-row" onSubmit={(event) => void rename(event)}>
          <Input
            aria-label="Set name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <Button size="sm" type="submit" variant="outline">
            Save
          </Button>
          <Button
            onClick={() => {
              setName(set.name);
              setEditing(false);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className="account-set-row">
      <Link
        search={{
          from: set.id,
          fromName: set.name,
          set: set.setTokens,
          taste: set.taste ?? "",
          view: "build" as const,
        }}
        to="/mix"
      >
        {set.name}
      </Link>
      <span className="account-set-actions">
        <Button onClick={() => setEditing(true)} size="sm" type="button" variant="ghost">
          Rename
        </Button>
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button size="sm" type="button" variant="ghost">
                Delete
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this set?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes “{set.name}” from your saved sets. The tracks stay in the archive.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                Delete set
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </span>
    </li>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactElement<{ id?: string }>;
  label: string;
}) {
  // useId keeps the id unique even when two forms carry the same label text (the auth
  // and settings forms both have a "Username" field).
  const id = `${useId()}-${label.toLowerCase().replaceAll(" ", "-")}`;

  return (
    <div className="account-field">
      <Label htmlFor={id}>{label}</Label>
      {isValidElement(children) ? cloneElement(children, { id }) : children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="account-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ListEmpty<T>({
  children,
  empty,
  items,
}: {
  children: React.ReactNode;
  empty: string;
  items: T[];
}) {
  return items.length > 0 ? (
    <ul className="account-list">{children}</ul>
  ) : (
    <p className="account-muted">{empty}</p>
  );
}

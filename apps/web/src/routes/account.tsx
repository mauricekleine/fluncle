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
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Tabs, TabsList, TabsTrigger } from "@fluncle/ui/components/tabs";
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
    image?: string;
    name: string;
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
  imageUrl?: string;
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
  const [loadFailed, setLoadFailed] = useState(false);
  const signedIn = !!me?.user;

  async function refresh() {
    setLoadFailed(false);

    try {
      await refreshInner();
    } catch {
      // A network blip must never strand the page on the loading line forever —
      // surface it and offer the retry.
      setLoadFailed(true);
    }
  }

  async function refreshInner() {
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

  const name = me?.user?.name || (me?.user?.displayUsername ?? me?.user?.username ?? "cosmonaut");

  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:p-8">
      <article className="home-plate account-plate mx-auto my-6 w-full max-w-3xl sm:my-8">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">Your place in the Galaxy</h1>
            <p className="home-tagline">Private progress, saved findings, and submissions.</p>
          </div>
        </header>

        {me === undefined ? (
          loadFailed ? (
            <div className="account-section">
              <p className="account-muted">Could not load your account. Check your connection.</p>
              <Button onClick={() => void refresh()} type="button" variant="outline">
                Try again
              </Button>
            </div>
          ) : (
            <p className="account-muted">Checking the manifest…</p>
          )
        ) : signedIn && me.user ? (
          <>
            <ClaimUsernameDialog csrfToken={csrfToken} refresh={refresh} user={me.user} />
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
          </>
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
  // "Join the crew" is the door most arrivals came through — default to joining.
  const [mode, setMode] = useState<"signin" | "signup">("signup");
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
          : // The recall-friendly identifier: a returning user remembers their
            // email more reliably than a handle picked in passing — accept either.
            username.includes("@")
            ? await authClient.signIn.email({ email: username, password })
            : await authClient.signIn.username({ password, username });

      if (result.error) {
        setMessage(result.error.message ?? "Could not sign in.");
        return;
      }

      await refresh();
      // Signing in needs no toast — the account appearing is the confirmation. A
      // sign-up keeps one useful line: where the verification link went.
      setMessage(
        mode === "signup"
          ? "I sent a link to verify your email. You're already signed in, so there's no rush."
          : "",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : mode === "signup"
            ? "Could not create the account."
            : "Could not sign in.",
      );
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
      <Field label={mode === "signin" ? "Email or username" : "Username"}>
        <Input
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      {mode === "signup" ? (
        <p className="account-muted text-xs">
          3–24 characters: lowercase letters, numbers, underscores. Your handle across Fluncle.
        </p>
      ) : null}
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
  const [setsMessage, setSetsMessage] = useState("");
  const joined = useMemo(() => formatDateLong(user.createdAt), [user.createdAt]);

  return (
    <div className="account-stack">
      <section className="account-section">
        <div className="account-row account-identity">
          <div className="account-identity-lead">
            {user.image ? (
              <img alt="" className="account-avatar" height={40} src={user.image} width={40} />
            ) : null}
            <div>
              <p className="account-kicker">Signed in as {name}</p>
              <p className="account-muted">
                Joined {joined}. Email stays private and never appears in public Fluncle surfaces.
              </p>
            </div>
          </div>
        </div>
        {message ? (
          <p aria-live="polite" className="account-muted">
            {message}
          </p>
        ) : null}
      </section>

      {/* The panels are driven by ?tab= alone — the account menu in the top bar is
          the switcher (operator ruling 2026-07-16), so the page carries no second
          tab strip of its own. */}
      {(tab ?? "galaxy") === "galaxy" ? (
        <div className="account-tab-panel">
          <section className="account-section">
            {(progress?.collectedLogIds.length ?? 0) > 0 ||
            (progress?.wins ?? 0) > 0 ||
            (progress?.deaths ?? 0) > 0 ? (
              <>
                <div className="account-row account-identity">
                  <div className="account-grid">
                    <Metric label="Lifetime logs" value={progress?.collectedLogIds.length ?? 0} />
                    <Metric label="Runs home" value={progress?.wins ?? 0} />
                    <Metric label="Tows" value={progress?.deaths ?? 0} />
                  </div>
                  <Button nativeButton={false} render={<Link to="/galaxy" />}>
                    Fly the Galaxy
                  </Button>
                </div>
                <p className="account-muted">
                  Your Galaxy game record: stars logged, runs flown home, and tows back to Earth
                  after a dry tank.
                </p>
              </>
            ) : (
              // A 0/0/0 scoreboard is not a welcome. Before the first flight, the
              // page leads with the door into the game and lets the collection's
              // teaching empty-state carry the rest.
              <div className="account-row account-identity">
                <p className="account-muted">
                  Every star you reach in the Galaxy gets logged here, along with your runs home.
                </p>
                <Button nativeButton={false} render={<Link to="/galaxy" />}>
                  Fly the Galaxy
                </Button>
              </div>
            )}
          </section>
          <CollectionSection collection={collection} />
        </div>
      ) : null}

      {tab === "saves" ? (
        <div className="account-tab-panel">
          <p className="account-kicker">Saves</p>
          <section className="account-section">
            <h2>Saved findings</h2>
            <ListEmpty
              items={saved}
              empty="Nothing saved yet. Tap the bookmark on any finding in the archive and it lands here."
            >
              {saved.map((finding) => (
                <SavedFindingRow
                  csrfToken={csrfToken}
                  finding={finding}
                  key={finding.trackId}
                  refresh={refresh}
                  setMessage={setSetsMessage}
                />
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
                  <Badge variant={submission.status === "approved" ? "default" : "outline"}>
                    {submission.status}
                  </Badge>
                </li>
              ))}
            </ListEmpty>
          </section>
        </div>
      ) : null}

      {tab === "settings" ? (
        <div className="account-tab-panel">
          <p className="account-kicker">Settings</p>
          <SettingsPanel
            csrfToken={csrfToken}
            refresh={refresh}
            setMessage={setMessage}
            user={user}
          />
        </div>
      ) : null}
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

/**
 * A saved finding, rendered the way every finding renders: cover first (the
 * recognition cue the user saved it by), coordinate, saved date — plus the one
 * management action this list owes the user: Remove. Removing a save destroys
 * nothing in the archive, so it is a plain action, not a confirm dialog.
 */
function SavedFindingRow({
  csrfToken,
  finding,
  refresh,
  setMessage,
}: {
  csrfToken: string;
  finding: SavedFinding;
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);

    try {
      const response = await fetch(`/api/me/saved-findings/${finding.trackId}`, {
        headers: { "x-fluncle-csrf": csrfToken },
        method: "DELETE",
      });

      setMessage(response.ok ? "" : "Could not remove that save. Try again in a moment.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="account-collection-row">
      {finding.imageUrl ? (
        <img
          alt=""
          className="account-collection-thumb"
          height={40}
          loading="lazy"
          src={albumCoverAtSize(finding.imageUrl, "small")}
          width={40}
        />
      ) : (
        <span aria-hidden className="account-collection-thumb" />
      )}
      <span className="account-collection-body">
        <Link to="/log/$logId" params={{ logId: finding.logId }}>
          {finding.artists.join(", ")} — {finding.title}
        </Link>
        <span className="account-collection-meta">
          <span className="account-collection-logid">{finding.logId}</span> · Saved{" "}
          {formatDateLong(finding.savedAt)}
          {finding.note ? <> · {finding.note}</> : null}
        </span>
      </span>
      <Button
        aria-label={`Remove ${finding.title} from saves`}
        disabled={busy}
        onClick={() => void remove()}
        size="sm"
        type="button"
        variant="ghost"
      >
        Remove
      </Button>
    </li>
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

// The dismissal marker for the claim-username dialog: per-tab-session, so "Not now"
// holds for the visit but the door knocks again next time — a missing handle keeps
// saves and submissions nameless, which is worth one quiet re-ask.
const CLAIM_DISMISSED_KEY = "fluncle-claim-username-dismissed";

/** The email's local part, folded into a valid handle suggestion ("hey@…" → "hey"). */
function suggestUsername(email: string): string {
  return (email.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

/**
 * The claim-username moment. A fresh Google arrival lands signed in but nameless —
 * instead of hiding a hint in Settings, the page opens one small dialog with the
 * handle prefilled from their email. Claiming is one tap; "Not now" dismisses it
 * for the session and Settings keeps the field either way.
 */
function ClaimUsernameDialog({
  csrfToken,
  refresh,
  user,
}: {
  csrfToken: string;
  refresh: () => Promise<void>;
  user: NonNullable<Me["user"]>;
}) {
  const [open, setOpen] = useState(
    () =>
      !user.username &&
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(CLAIM_DISMISSED_KEY) !== "1",
  );
  const [value, setValue] = useState(() => suggestUsername(user.email));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function dismiss() {
    window.sessionStorage.setItem(CLAIM_DISMISSED_KEY, "1");
    setOpen(false);
  }

  async function claim(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/me/profile", {
        body: JSON.stringify({ name: user.name || value, username: value }),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "PATCH",
      });

      if (!response.ok) {
        setError(((await response.json()) as { message: string }).message);

        return;
      }

      setOpen(false);
      await refresh();
    } catch {
      setError("Could not save right now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (user.username) {
    return null;
  }

  return (
    <Dialog onOpenChange={(next: boolean) => (next ? setOpen(true) : dismiss())} open={open}>
      <DialogContent>
        <form onSubmit={(event) => void claim(event)}>
          <DialogHeader>
            <DialogTitle>Claim your username</DialogTitle>
            <DialogDescription>
              Your handle across Fluncle: it names your saves and submissions. You can change it
              later in Settings.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Field label="Username">
              <Input autoFocus onChange={(event) => setValue(event.target.value)} value={value} />
            </Field>
            {error ? (
              <p aria-live="polite" className="account-muted mt-2">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button disabled={busy} onClick={dismiss} type="button" variant="ghost">
              Not now
            </Button>
            <Button disabled={busy || value.trim().length < 3} type="submit">
              {busy ? "Claiming…" : "Claim username"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const [name, setName] = useState(user.name);
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
        body: JSON.stringify({ name, username }),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "PATCH",
      });

      setSettingsMessage(
        response.ok ? "Profile updated." : ((await response.json()) as { message: string }).message,
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
      const text = JSON.stringify(data.export ?? data, null, 2);

      setExportText(text);
      // "Export" means a FILE lands — the textarea stays as the preview, but the
      // download is the deliverable.
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.download = "fluncle-account.json";
      anchor.href = url;
      anchor.click();
      URL.revokeObjectURL(url);
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
      <form className="account-section" onSubmit={(event) => void patchProfile(event)}>
        <h2>Profile</h2>
        {/* The two-name model: Username is the handle, Name is what shows in the top
            bar. No third field — a "display name" next to both was one name too many. */}
        <Field label="Username">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <p className="account-muted text-xs">
          Your handle. 3–24 characters: lowercase letters, numbers, underscores.
        </p>
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <p className="account-muted text-xs">Shown in the top bar and on your account.</p>
        <div className="account-row">
          <Button disabled={settingsBusy} type="submit">
            {settingsBusy ? "Updating…" : "Update profile"}
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
        <h2>Preferences</h2>
        <p className="account-muted">
          Pick how keys read: Scales or Camelot. The choice saves to your account and follows you
          onto every device you sign in on.
        </p>
        <div className="account-field">
          <span className="text-sm font-medium">Key notation</span>
          <KeyNotationToggle />
          <p aria-live="polite" className="account-muted">
            Keys read as {formatKey("G# minor", notation)}.
          </p>
        </div>
      </section>

      <section className="account-section">
        {/* Developer content recedes behind a disclosure (the Quiet Surface Rule) —
            present for the crew that wants it, invisible to everyone else. */}
        <details className="account-details">
          <summary className="account-details-summary">Link the CLI</summary>
          <p className="account-muted">
            Got the <code>fluncle</code> CLI? Run <code>fluncle login</code> in your terminal to
            link this device and sync your Galaxy from the command line. I&rsquo;ll send you back
            here to approve it.
          </p>
        </details>
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

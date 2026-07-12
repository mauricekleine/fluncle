import { createFileRoute, Link } from "@tanstack/react-router";
import { cloneElement, isValidElement, useEffect, useMemo, useReducer, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { Tabs, TabsList, TabsTrigger } from "@fluncle/ui/components/tabs";
import { Textarea } from "@fluncle/ui/components/textarea";
import { authClient } from "@/lib/auth-client";
import { siteUrl } from "@/lib/fluncle-links";

type Me = {
  ok: true;
  user: null | {
    createdAt: string;
    displayUsername?: string;
    id: string;
    username?: string;
  };
};

type Progress = {
  collectedLogIds: string[];
  deaths: number;
  wins: number;
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
      csrfToken: string;
      me: Me;
      progress: Progress;
      saved: SavedFinding[];
      sets: SavedSet[];
      submissions: Submission[];
      type: "loaded";
    };

const initialAccountState: AccountState = {
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

export const Route = createFileRoute("/account")({
  component: AccountPage,
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
});

function AccountPage() {
  const [{ csrfToken, me, progress, saved, sets, submissions }, dispatch] = useReducer(
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

    const [progressResponse, savedResponse, setsResponse, submissionsResponse, csrfResponse] =
      await Promise.all([
        fetch("/api/me/galaxy-progress").then((res) => res.json() as Promise<Progress>),
        fetch("/api/me/saved-findings").then(
          (res) => res.json() as Promise<{ savedFindings?: SavedFinding[] }>,
        ),
        fetch("/api/me/saved-sets").then(
          (res) => res.json() as Promise<{ savedSets?: SavedSet[] }>,
        ),
        fetch("/api/me/submissions").then(
          (res) => res.json() as Promise<{ submissions?: Submission[] }>,
        ),
        fetch("/api/me/csrf").then((res) => res.json() as Promise<{ csrfToken?: string }>),
      ]);

    dispatch({
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
          <AuthForms refresh={refresh} setMessage={setMessage} />
        )}
      </article>
    </main>
  );
}

function AuthForms({
  refresh,
  setMessage,
}: {
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");

    try {
      const result =
        mode === "signup"
          ? await authClient.signUp.email({
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
      setMessage("Aboard. Your private Galaxy state is ready.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not sign in.");
    }
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
      <Button type="submit">{mode === "signup" ? "Create private account" : "Sign in"}</Button>
    </form>
  );
}

function SignedInAccount({
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
  const [username, setUsername] = useState(user.username ?? "");
  const [displayUsername, setDisplayUsername] = useState(
    user.displayUsername ?? user.username ?? "",
  );
  const [exportText, setExportText] = useState("");
  const joined = useMemo(() => new Date(user.createdAt).toLocaleDateString(), [user.createdAt]);

  async function patchProfile(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/me/profile", {
      body: JSON.stringify({ displayUsername, username }),
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "PATCH",
    });

    setMessage(
      response.ok ? "Username updated." : ((await response.json()) as { message: string }).message,
    );
    await refresh();
  }

  async function exportData() {
    const response = await fetch("/api/me/export", {
      body: "{}",
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "POST",
    });
    const data = (await response.json()) as { export?: unknown };

    setExportText(JSON.stringify(data.export ?? data, null, 2));
  }

  async function deleteData() {
    const response = await fetch("/api/me/delete", {
      body: "{}",
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
      method: "POST",
    });

    setMessage(
      response.ok ? "Account deleted. Anonymous mode is still here." : "Could not delete account.",
    );
    await refresh();
  }

  async function signOut() {
    await authClient.signOut();
    await refresh();
  }

  return (
    <div className="account-stack">
      <section className="account-section">
        <p className="account-kicker">Signed in as {name}</p>
        <p className="account-muted">
          Joined {joined}. Email stays private and never appears in public Fluncle surfaces.
        </p>
      </section>

      <section className="account-grid">
        <Metric label="Lifetime logs" value={progress?.collectedLogIds.length ?? 0} />
        <Metric label="Runs home" value={progress?.wins ?? 0} />
        <Metric label="Tows" value={progress?.deaths ?? 0} />
      </section>

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
              setMessage={setMessage}
            />
          ))}
        </ListEmpty>
      </section>

      <section className="account-section">
        <h2>Your submissions</h2>
        <ListEmpty items={submissions} empty="No submissions from this account yet.">
          {submissions.map((submission) => (
            <li key={submission.id}>
              {submission.artists.join(", ")} — {submission.title} <span>{submission.status}</span>
            </li>
          ))}
        </ListEmpty>
      </section>

      <section className="account-section">
        <h2>Link the CLI</h2>
        <p className="account-muted">
          Got the <code>fluncle</code> CLI? Run <code>fluncle login</code> in your terminal to link
          this device and sync your Galaxy from the command line. I&rsquo;ll send you back here to
          approve it.
        </p>
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
        <Button type="submit" variant="outline">
          Update settings
        </Button>
      </form>

      <section className="account-section">
        <h2>Export and deletion</h2>
        <p className="account-muted">
          Export includes private progress, saved findings, saved sets, and signed-in submissions.
          Deletion removes private progress, saves, and sets, revokes sessions, and unlinks
          submissions from this account.
        </p>
        <div className="account-row">
          <Button type="button" variant="outline" onClick={() => void exportData()}>
            Export data
          </Button>
          <Button type="button" variant="destructive" onClick={() => void deleteData()}>
            Delete account
          </Button>
          <Button type="button" variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
        {exportText ? (
          <Textarea readOnly className="min-h-48 font-mono text-xs" value={exportText} />
        ) : null}
      </section>
      {message ? <p className="account-muted">{message}</p> : null}
    </div>
  );
}

// One saved set: open it back on /mix (the stored tokens + taste handed straight to
// the route's loader — no new hydration path), rename it, or delete it. Rename +
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
    <li>
      <Link
        search={{ set: set.setTokens, taste: set.taste ?? "", view: "build" as const }}
        to="/mix"
      >
        {set.name}
      </Link>{" "}
      <Button onClick={() => setEditing(true)} size="sm" type="button" variant="ghost">
        Rename
      </Button>
      <Button onClick={() => void remove()} size="sm" type="button" variant="ghost">
        Delete
      </Button>
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
  const id = label.toLowerCase().replaceAll(" ", "-");

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

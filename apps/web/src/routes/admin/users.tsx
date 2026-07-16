import { PlanetIcon, ProhibitIcon, SealCheckIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type UserAdminItem } from "@fluncle/contracts";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { formatDate } from "@/lib/format";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listAdminUsers } from "@/lib/server/users";

// The `/admin/users` station — the account roster, and the operator's READ-ONLY
// window on the gated rollout of the account-backed features (saved findings, saved
// `/mix` sets, the Galaxy). Every account the site knows is a row here, newest-first,
// so the operator can watch the crew roster grow as those features open up.
//
// READ-ONLY, and deliberately so: this page mints nothing, suspends nothing, deletes
// nothing. The account lifecycle (verify, suspend, the deletion that ANONYMIZES the
// row) lives behind Better Auth and the user's own `/me` tier — never an operator
// mutation here. The row's right edge is the rollout signal it exists to show: how
// many findings and sets an account has saved, and whether it has touched the Galaxy.

const USERS_KEY = ["admin", "users"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchUsers = createServerFn({ method: "GET" }).handler(async (): Promise<UserAdminItem[]> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listAdminUsers();
});

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/users")({
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchUsers(),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const initial = Route.useLoaderData();
  const { data: users } = useQuery({
    initialData: initial,
    queryFn: () => fetchUsers(),
    queryKey: USERS_KEY,
    refetchOnWindowFocus: true,
  });

  const verifiedCount = users.filter((user) => user.emailVerified).length;

  const subtitle =
    users.length === 0
      ? "No accounts yet"
      : `${users.length} ${users.length === 1 ? "account" : "accounts"} · ${verifiedCount} verified`;

  return (
    <AdminShell subtitle={subtitle} title="Users">
      <div className="space-y-6 p-4 sm:p-5">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every account, newest first. A read-only window on the rollout: the right edge shows what
          each one has saved and whether it has touched the Galaxy. Nothing here changes an account:
          that stays with the account itself.
        </p>

        {users.length === 0 ? (
          <EmptyUsers />
        ) : (
          <ObjectList>
            {users.map((user) => (
              <UserRow key={user.id} user={user} />
            ))}
          </ObjectList>
        )}
      </div>
    </AdminShell>
  );
}

// No account exists yet — the roster is empty. Quiet and honest, no fake rows.
function EmptyUsers() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-border bg-card/60 px-6 py-12 text-center">
      <UserCircleIcon
        aria-hidden="true"
        className="mx-auto mb-3 size-8 text-muted-foreground"
        weight="thin"
      />
      <p className="text-sm font-medium">No accounts yet</p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        The first person to sign in lands here, and the roster grows from there.
      </p>
    </div>
  );
}

function UserRow({ user }: { user: UserAdminItem }) {
  // The handle line: the chosen username if there is one, else the email — whichever is the
  // account's most human identifier stands in as the coordinate.
  const handle = user.username ? `@${user.username}` : user.email;
  // The visible name, falling back to the handle for a name-less (or anonymized) row so a
  // row is never blank.
  const title = user.name.trim() || handle;

  return (
    <ObjectRow trailing={<UserArtifacts user={user} />}>
      <ObjectLead
        coordinate={handle}
        leading={<UserAvatar image={user.image} />}
        subtitle={<UserMeta user={user} />}
        title={title}
      />
    </ObjectRow>
  );
}

// The account's own avatar (from its identity provider), at the object row's md plate
// footprint. Falls back to the user glyph when there is none. Decorative (the name sits
// beside it), lazy-loaded.
function UserAvatar({ image }: { image: string | null }) {
  if (!image) {
    return <ObjectGlyph icon={UserCircleIcon} />;
  }

  return (
    <img
      alt=""
      className="size-11 shrink-0 rounded-md border border-border object-cover"
      loading="lazy"
      src={image}
    />
  );
}

// The quiet meta line: verified state, when they joined, when they were last seen, and a
// status word for the rare non-active account. All in the admin's flat functional register.
function UserMeta({ user }: { user: UserAdminItem }) {
  return (
    <>
      {user.emailVerified ? (
        <span className="inline-flex items-center gap-1">
          <SealCheckIcon aria-hidden="true" className="size-3.5" weight="fill" />
          Verified
        </span>
      ) : (
        <span>Unverified</span>
      )}
      <span>Joined {formatDate(user.createdAt)}</span>
      <span>{user.lastSeenAt ? `Seen ${formatDate(user.lastSeenAt)}` : "Not seen yet"}</span>
      {user.status === "active" ? null : (
        <span className="inline-flex items-center gap-1">
          <ProhibitIcon aria-hidden="true" className="size-3.5" weight="regular" />
          {user.status === "suspended" ? "Suspended" : "Deleted"}
        </span>
      )}
    </>
  );
}

// The rollout signal, right-aligned: how many findings and sets this account has saved, and
// whether it has touched the Galaxy. Quiet data, tabular — never an alarm.
function UserArtifacts({ user }: { user: UserAdminItem }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
      <span>{user.savedFindingCount} saved</span>
      <span>
        {user.savedSetCount} {user.savedSetCount === 1 ? "set" : "sets"}
      </span>
      {user.hasGalaxyProgress ? (
        <span className="inline-flex items-center gap-1">
          <PlanetIcon aria-hidden="true" className="size-3.5" weight="fill" />
          Galaxy
        </span>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// syncLibSQL SPIKE HARNESS — the de-risking spike that gates offline-first slice 2
// ─────────────────────────────────────────────────────────────────────────────
//
// Slice 2 wants a synced local libSQL replica on the device (expo-sqlite's native
// libSQL integration). The load-bearing unknown is whether `syncLibSQL()` actually
// works against a live Turso database from a real app — first in the simulator, then
// on a real device. This screen runs that end to end and puts a verdict on the glass.
//
// DEV-ONLY. The component redirects home unless `__DEV__`, so the route ships dead in a
// store build. It is linked from no navigation: reach it by typing the path or by deep
// link.
//
// ── THE ONE PREREQUISITE ─────────────────────────────────────────────────────
// expo-sqlite compiles libSQL as a BUILD-TIME variant, not a runtime option. Its
// podspec/gradle swaps the whole native module (SQLiteModuleLibSQL replaces
// SQLiteModule) only when the config plugin sets `useLibSQL`:
//
//   plugins: [["expo-sqlite", { useLibSQL: true }]]     // in app.config.js
//
// followed by a fresh `expo prebuild` + native build. Expo Go can NEVER carry it, and
// neither can a dev client built without the prop. Without it `openDatabaseAsync`
// quietly opens a PLAIN LOCAL FILE and the first `syncLibSQL()` throws "syncLibSQL is
// not supported in the current environment" — which this screen recognises and explains
// on the glass rather than leaving as a bare native message.
// (That prop is NOT set in app.config.js as of this commit — see the PR body.)
//
// ── RUN RECIPE ───────────────────────────────────────────────────────────────
// 1. Seed the remote (server-side, once) with the table the spike reads:
//      create table if not exists spike_tracks (id integer primary key, title text);
//      -- plus a few rows
// 2. Export both env vars BEFORE starting the bundler. Expo inlines EXPO_PUBLIC_* at
//    BUNDLE time, so exporting mid-session does nothing until the bundler restarts:
//      export EXPO_PUBLIC_SPIKE_SYNC_URL='libsql://<db>.turso.io'
//      export EXPO_PUBLIC_SPIKE_TOKEN='<token>'
// 3. Build and start the dev client (a prebuild is required by the prop above):
//      bun run --cwd apps/mobile prebuild
//      bun run --cwd apps/mobile ios          # or: android
// 4. Open the screen — either navigate to `/dev/sync-spike` in the dev client, or deep
//    link it (the app's scheme is `fluncle`, per app.config.js):
//      npx uri-scheme open 'fluncle://dev/sync-spike' --ios
// 5. Tap "Run spike", read the last line, and "Copy log" to share the run out.
//
// No URL and no token are hard-coded here, and the log prints NEITHER: the host is
// masked and the token is described by length only (this repo is public and the log
// leaves the device through a share sheet).
//
// ── VERIFIED API SURFACE (expo-sqlite 56.0.5, read off the installed package) ──
//   • libSQL mode is entered by passing `libSQLOptions: { url, authToken, remoteOnly? }`
//     to `openDatabaseAsync`/`openDatabaseSync` (SQLiteOpenOptions). There is no
//     `useLibSQL` OPEN option — that name is the config plugin's build prop.
//   • Sync is a METHOD on the handle: `await db.syncLibSQL(): Promise<void>`. There is
//     no top-level `syncLibSQL(db)` export.
//   • Two libSQL-mode limits worth knowing before slice 2 designs on top of this:
//     NAMED parameter binding is unsupported (positional `?` only), and
//     `enableChangeListener` is unsupported.
//
// The step ordering and failure semantics live in the pure, tested @/lib/spike-sync;
// this file is the thin native + view layer over it.

import { useCallback, useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { Redirect } from "expo-router";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  describeSyncTarget,
  describeToken,
  formatSpikeLine,
  formatSpikeLog,
  readSpikeConfig,
  runSpike,
  SPIKE_PASS,
  SPIKE_SYNC_URL_ENV,
  SPIKE_TOKEN_ENV,
  type SpikeConfig,
  type SpikeLine,
  type SpikeStep,
} from "@/lib/spike-sync";
import { color, font, radius } from "@/theme/tokens";

// The local replica file. Distinct from anything slice 2 will use, so a spike run can
// never collide with real app data.
const SPIKE_DB_NAME = "spike-libsql.db";

// Seeded server-side by the orchestrator; the spike only READS it.
const REMOTE_TABLE = "spike_tracks";

// The local write target. Deliberately NOT the remote table: the spike proves a local
// write lands on a synced handle without pushing anything into the seeded data.
// NOTE: libSQL sync is bidirectional (expo-sqlite carries offline-writes support), so
// the sync that follows may well replicate this scratch table upstream. That is itself
// a spike observation — the distinct name keeps it harmless either way.
const LOCAL_SCRATCH_TABLE = "spike_local_scratch";

// Expo's inlining only fires on a literal `process.env.EXPO_PUBLIC_*` member access, so
// the two reads must sit here verbatim. Everything downstream takes plain strings.
const RAW_SYNC_URL = process.env.EXPO_PUBLIC_SPIKE_SYNC_URL;
const RAW_TOKEN = process.env.EXPO_PUBLIC_SPIKE_TOKEN;

/** Narrows the handle without a non-null assertion (banned repo-wide). */
function requireDb(db: SQLiteDatabase | undefined): SQLiteDatabase {
  if (db === undefined) {
    throw new Error("no database handle (the open step did not complete)");
  }
  return db;
}

/**
 * The ordered spike. Each step is one native leg, so the sequencer's per-step timing IS
 * that leg's wall clock — which is how both syncs get measured.
 */
function buildSteps(config: SpikeConfig): readonly SpikeStep[] {
  let db: SQLiteDatabase | undefined;

  return [
    {
      // Fatal: with no handle, every later step is noise.
      fatal: true,
      id: "1-open-libsql",
      run: async () => {
        db = await openDatabaseAsync(SPIKE_DB_NAME, {
          libSQLOptions: { authToken: config.token, url: config.syncUrl },
          // A run closes its handle at the end; without this, a SECOND run would be
          // handed the closed cached connection.
          useNewConnection: true,
        });
        return `${SPIKE_DB_NAME} open, target ${describeSyncTarget(config.syncUrl)}`;
      },
    },
    {
      id: "2-first-sync-pull",
      run: async () => {
        await requireDb(db).syncLibSQL();
        return "pulled";
      },
    },
    {
      id: `3-read-${REMOTE_TABLE}`,
      run: async () => {
        const handle = requireDb(db);
        const counted = await handle.getFirstAsync<{ n: number }>(
          `select count(*) as n from ${REMOTE_TABLE}`,
        );
        const rows = await handle.getAllAsync<{ id: number; title: string }>(
          `select id, title from ${REMOTE_TABLE} order by id limit 3`,
        );
        const preview = rows.map((row) => `${row.id}:${row.title}`).join(", ");
        return `count=${counted?.n ?? "?"} rows=[${preview}]`;
      },
    },
    {
      id: "4-local-write",
      run: async () => {
        const handle = requireDb(db);
        await handle.execAsync(
          `create table if not exists ${LOCAL_SCRATCH_TABLE} (id integer primary key not null, wrote_at text not null)`,
        );
        // Positional binding only: libSQL mode rejects NAMED parameters.
        const written = await handle.runAsync(
          `insert into ${LOCAL_SCRATCH_TABLE} (wrote_at) values (?)`,
          new Date().toISOString(),
        );
        const back = await handle.getFirstAsync<{ n: number }>(
          `select count(*) as n from ${LOCAL_SCRATCH_TABLE}`,
        );
        return `rowid=${written.lastInsertRowId} changes=${written.changes} scratchRows=${back?.n ?? "?"}`;
      },
    },
    {
      // The interesting number: a no-op pull should be markedly cheaper than the first.
      id: "5-second-sync-noop",
      run: async () => {
        await requireDb(db).syncLibSQL();
        return "pulled (expected no-op)";
      },
    },
    {
      id: "6-close",
      run: async () => {
        await requireDb(db).closeAsync();
        return "closed";
      },
    },
  ];
}

function lineColor(line: SpikeLine): string {
  if (line.kind === "error") {
    return color.reentryRed;
  }
  if (line.kind === "hint") {
    return color.eclipseGold;
  }
  if (line.kind === "verdict") {
    return line.text === SPIKE_PASS ? color.eclipseGold : color.reentryRed;
  }
  if (line.kind === "skipped") {
    return color.stardust;
  }
  return color.starlightCream;
}

export default function SyncSpikeScreen() {
  // Hard gate: dead route in a store build.
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <SyncSpike />;
}

function SyncSpike() {
  const [lines, setLines] = useState<readonly SpikeLine[]>([]);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<string | undefined>(undefined);

  const configResult = readSpikeConfig({ syncUrl: RAW_SYNC_URL, token: RAW_TOKEN });

  const run = useCallback(async () => {
    if (configResult.kind !== "ready") {
      return;
    }
    setLines([]);
    setVerdict(undefined);
    setRunning(true);
    try {
      const result = await runSpike(buildSteps(configResult.config), {
        onLine: (line) => setLines((previous) => [...previous, line]),
      });
      setVerdict(result.verdict);
    } finally {
      setRunning(false);
    }
  }, [configResult]);

  const copyLog = useCallback(() => {
    // No expo-clipboard in this app; the RN core share sheet is already the app's way
    // of handing text out (see components/feed-card.tsx).
    void Share.share({ message: formatSpikeLog(lines) });
  }, [lines]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>syncLibSQL spike</Text>
        <Text style={styles.subtitle}>
          expo-sqlite {REMOTE_TABLE} pull, local write, no-op pull. Dev-only.
        </Text>
      </View>

      {configResult.kind === "missing" ? (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Not configured</Text>
          <Text style={styles.noticeBody}>
            Missing: {configResult.missing.join(", ")}. Export {SPIKE_SYNC_URL_ENV} and{" "}
            {SPIKE_TOKEN_ENV}, then restart the bundler (EXPO_PUBLIC_* is inlined at bundle time).
          </Text>
        </View>
      ) : (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Configured</Text>
          <Text style={styles.noticeBody}>
            target {describeSyncTarget(configResult.config.syncUrl)}, token{" "}
            {describeToken(configResult.config.token)}
          </Text>
        </View>
      )}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: running || configResult.kind !== "ready" }}
          disabled={running || configResult.kind !== "ready"}
          onPress={() => void run()}
          style={[
            styles.button,
            styles.buttonPrimary,
            (running || configResult.kind !== "ready") && styles.buttonDisabled,
          ]}
        >
          <Text style={styles.buttonPrimaryLabel}>{running ? "Running..." : "Run spike"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: lines.length === 0 }}
          disabled={lines.length === 0}
          onPress={copyLog}
          style={[styles.button, lines.length === 0 && styles.buttonDisabled]}
        >
          <Text style={styles.buttonLabel}>Copy log</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.logBody} style={styles.log}>
        {lines.length === 0 ? (
          <Text style={styles.empty}>No run yet.</Text>
        ) : (
          lines.map((line, index) => (
            <Text
              // The log is append-only within a run, so the index is a stable identity.
              key={`${index}-${line.elapsedMs}`}
              selectable
              style={[styles.line, { color: lineColor(line) }]}
            >
              {formatSpikeLine(line)}
            </Text>
          ))
        )}
      </ScrollView>

      {verdict === undefined ? null : (
        <Text
          selectable
          style={[
            styles.verdict,
            { color: verdict === SPIKE_PASS ? color.eclipseGold : color.reentryRed },
          ]}
        >
          {verdict}
        </Text>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
  },
  button: {
    borderColor: color.dustLine,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonLabel: {
    ...font.label,
    color: color.starlightCream,
  },
  buttonPrimary: {
    backgroundColor: color.eclipseGold,
    borderColor: color.eclipseGold,
  },
  buttonPrimaryLabel: {
    ...font.label,
    color: color.inkOnGold,
  },
  empty: {
    ...font.body,
    color: color.stardust,
  },
  header: {
    gap: 4,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  line: {
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16,
  },
  log: {
    flex: 1,
    marginHorizontal: 20,
    marginTop: 16,
  },
  logBody: {
    gap: 2,
    paddingBottom: 16,
  },
  notice: {
    borderColor: color.dustLine,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: 4,
    marginHorizontal: 20,
    marginTop: 16,
    padding: 12,
  },
  noticeBody: {
    ...font.body,
    color: color.stardust,
  },
  noticeTitle: {
    ...font.label,
    color: color.starlightCream,
  },
  screen: {
    backgroundColor: color.deepField,
    flex: 1,
  },
  subtitle: {
    ...font.body,
    color: color.stardust,
  },
  title: {
    ...font.label,
    color: color.starlightCream,
  },
  verdict: {
    ...font.label,
    paddingBottom: 16,
    paddingHorizontal: 20,
  },
});

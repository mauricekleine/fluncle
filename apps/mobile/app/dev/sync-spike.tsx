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

const SPIKE_DB_NAME = "spike-libsql.db";

const REMOTE_TABLE = "spike_tracks";

const LOCAL_SCRATCH_TABLE = "spike_local_scratch";

const RAW_SYNC_URL = process.env.EXPO_PUBLIC_SPIKE_SYNC_URL;
const RAW_TOKEN = process.env.EXPO_PUBLIC_SPIKE_TOKEN;

function requireDb(db: SQLiteDatabase | undefined): SQLiteDatabase {
  if (db === undefined) {
    throw new Error("no database handle (the open step did not complete)");
  }
  return db;
}

function buildSteps(config: SpikeConfig): readonly SpikeStep[] {
  let db: SQLiteDatabase | undefined;

  return [
    {
      fatal: true,
      id: "1-open-libsql",
      run: async () => {
        db = await openDatabaseAsync(SPIKE_DB_NAME, {
          libSQLOptions: { authToken: config.token, url: config.syncUrl },

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

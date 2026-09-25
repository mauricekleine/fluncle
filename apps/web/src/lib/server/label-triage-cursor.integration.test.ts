import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import { labelTriageProposalsByIds, recordLabelTriage } from "./labels";

let db: Client;

async function labelRow(slug: string) {
  const result = await db.execute({
    args: [slug],
    sql: `select triage_checked_at, triage_verdict, triage_reason, seed_state, ruled_at
          from labels where slug = ? limit 1`,
  });

  return result.rows[0] as
    | undefined
    | {
        ruled_at: string | null;
        seed_state: string;
        triage_checked_at: string | null;
        triage_reason: string | null;
        triage_verdict: string | null;
      };
}

async function proposals(slug: string) {
  const result = await db.execute({
    args: [slug],
    sql: `select p.id, p.round_id, p.verdict, p.off_lane_share, p.residual_off_lane_share,
                 p.verify_agrees
          from label_triage_proposals p
          join labels l on l.id = p.label_id
          where l.slug = ?`,
  });

  return result.rows;
}

async function ruleProposals(slug: string) {
  const result = await db.execute({
    args: [slug],
    sql: `select r.artist_name, r.verdict, r.first_credit_count
          from label_triage_rule_proposals r
          join label_triage_proposals p on p.id = r.proposal_id
          join labels l on l.id = p.label_id
          where l.slug = ?
          order by r.artist_name`,
  });

  return result.rows as unknown as {
    artist_name: string;
    first_credit_count: number;
    verdict: string;
  }[];
}

async function seedLabel(slug: string, seedState = "undecided") {
  const now = new Date().toISOString();
  await db.execute({
    args: [`lbl_${slug}`, slug, slug, seedState, now, now],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function labelId(slug: string): Promise<string> {
  const result = await db.execute({ args: [slug], sql: `select id from labels where slug = ?` });

  return (result.rows[0] as unknown as { id: string }).id;
}

const BASE = {
  confidence: "high" as const,
  evidence: "MB releases are all jungle",
  roundId: "r14",
  verdict: "unclear" as const,
};

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

describe("the triage cursor", () => {
  it("returns undefined for a label that does not exist, rather than minting one", async () => {
    expect(await recordLabelTriage("ghost", BASE)).toBeUndefined();
  });

  it("stamps the cursor with the verdict and the reason it could not be ruled", async () => {
    await seedLabel("acme");
    const recorded = await recordLabelTriage("acme", { ...BASE, reason: "conflation" });

    const row = await labelRow("acme");
    expect(row?.triage_checked_at).toBe(recorded?.triageCheckedAt);
    expect(row?.triage_verdict).toBe("unclear");
    expect(row?.triage_reason).toBe("conflation");
  });

  it("NEVER changes the seed state or the operator's ruling stamp", async () => {
    await seedLabel("acme");
    await recordLabelTriage("acme", { ...BASE, verdict: "dnb" });

    const row = await labelRow("acme");
    expect(row?.seed_state).toBe("undecided");
    expect(row?.ruled_at).toBeNull();
  });

  it("stores the round's payload as a proposal", async () => {
    await seedLabel("acme");
    await recordLabelTriage("acme", {
      ...BASE,
      offLaneShare: 0.205,
      residualOffLaneShare: 0.147,
      verifyAgrees: false,
    });

    const [proposal] = await proposals("acme");
    expect(proposal?.round_id).toBe("r14");
    expect(proposal?.off_lane_share).toBeCloseTo(0.205);
    expect(proposal?.residual_off_lane_share).toBeCloseTo(0.147);
    expect(proposal?.verify_agrees).toBe(0);
  });

  it("keeps rule proposals that can fire and drops the inert ones", async () => {
    await seedLabel("acme");
    const recorded = await recordLabelTriage("acme", {
      ...BASE,
      rules: [
        { artistMbid: "mbid-a", artistName: "Fires", firstCreditCount: 12, verdict: "allow" },
        { artistMbid: "mbid-b", artistName: "Inert", firstCreditCount: 0, verdict: "block" },
      ],
    });

    expect(recorded?.droppedInertRules).toBe(1);
    expect(await ruleProposals("acme")).toEqual([
      { artist_name: "Fires", first_credit_count: 12, verdict: "allow" },
    ]);
  });

  it("supersedes an earlier round for the same label instead of accumulating", async () => {
    await seedLabel("acme");
    const first = await recordLabelTriage("acme", {
      ...BASE,
      roundId: "r14",
      rules: [{ artistMbid: "mbid-a", artistName: "Old", firstCreditCount: 3, verdict: "allow" }],
    });
    expect(first?.superseded).toBe(false);

    const second = await recordLabelTriage("acme", {
      ...BASE,
      roundId: "r15",
      rules: [{ artistMbid: "mbid-b", artistName: "New", firstCreditCount: 5, verdict: "allow" }],
    });

    expect(second?.superseded).toBe(true);
    const rows = await proposals("acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.round_id).toBe("r15");
  });

  it("takes the superseded round's rule proposals with it, leaving no orphans", async () => {
    await seedLabel("acme");
    await recordLabelTriage("acme", {
      ...BASE,
      rules: [{ artistMbid: "mbid-a", artistName: "Old", firstCreditCount: 3, verdict: "allow" }],
    });
    await recordLabelTriage("acme", { ...BASE, roundId: "r15", rules: [] });

    expect(await ruleProposals("acme")).toEqual([]);
    const orphans = await db.execute(`select count(*) as n from label_triage_rule_proposals`);
    expect(Number(orphans.rows[0]?.n)).toBe(0);
  });

  it("keeps one label's proposal when another label is re-triaged", async () => {
    await seedLabel("acme");
    await seedLabel("other");
    await recordLabelTriage("acme", BASE);
    await recordLabelTriage("other", BASE);
    await recordLabelTriage("other", { ...BASE, roundId: "r15" });

    expect(await proposals("acme")).toHaveLength(1);
    expect(await proposals("other")).toHaveLength(1);
  });

  it("records a round that looked at an already-ruled label without disturbing the ruling", async () => {
    await seedLabel("acme", "enabled");
    await recordLabelTriage("acme", { ...BASE, verdict: "not_dnb" });

    const row = await labelRow("acme");
    expect(row?.seed_state).toBe("enabled");
    expect(row?.triage_verdict).toBe("not_dnb");
  });

  it("leaves the cursor null on a label no round has seen, which is what never-seen means", async () => {
    await seedLabel("untouched");

    const row = await labelRow("untouched");
    expect(row?.triage_checked_at).toBeNull();
    expect(row?.triage_verdict).toBeNull();
  });
});

describe("the ratification read", () => {
  it("returns nothing for an empty id list, without touching the database", async () => {
    expect(await labelTriageProposalsByIds([])).toEqual(new Map());
  });

  it("omits a label no round has looked at, rather than returning an empty shell", async () => {
    await seedLabel("unseen");
    const map = await labelTriageProposalsByIds([await labelId("unseen")]);
    expect(map.size).toBe(0);
  });

  it("carries the census arithmetic and the second opinion back to the station", async () => {
    await seedLabel("acme");
    await recordLabelTriage("acme", {
      ...BASE,
      censusSummary: "9 releases, 74 recordings",
      offLaneShare: 0.59,
      residualOffLaneShare: 0.42,
      verifyAgrees: false,
      verifyEvidence: "Discogs styles contradict the first pass",
    });

    const id = await labelId("acme");
    const proposal = (await labelTriageProposalsByIds([id])).get(id);

    expect(proposal?.censusSummary).toBe("9 releases, 74 recordings");
    expect(proposal?.offLaneShare).toBeCloseTo(0.59);
    expect(proposal?.residualOffLaneShare).toBeCloseTo(0.42);
    expect(proposal?.verifyAgrees).toBe(false);
    expect(proposal?.verifyEvidence).toBe("Discogs styles contradict the first pass");
  });

  it("orders a proposal's rules by first-credit weight, so the load-bearing act reads first", async () => {
    await seedLabel("acme");
    await recordLabelTriage("acme", {
      ...BASE,
      rules: [
        { artistMbid: "mbid-a", artistName: "Minor", firstCreditCount: 1, verdict: "allow" },
        { artistMbid: "mbid-b", artistName: "Major", firstCreditCount: 12, verdict: "allow" },
      ],
    });

    const id = await labelId("acme");
    const proposal = (await labelTriageProposalsByIds([id])).get(id);

    expect(proposal?.rules.map((rule) => rule.artistName)).toEqual(["Major", "Minor"]);
  });

  it("keeps each label's rules with its own proposal when several are read at once", async () => {
    await seedLabel("one");
    await seedLabel("two");
    await recordLabelTriage("one", {
      ...BASE,
      rules: [{ artistMbid: "mbid-a", artistName: "First", firstCreditCount: 3, verdict: "allow" }],
    });
    await recordLabelTriage("two", {
      ...BASE,
      rules: [
        { artistMbid: "mbid-b", artistName: "Second", firstCreditCount: 4, verdict: "block" },
      ],
    });

    const map = await labelTriageProposalsByIds([await labelId("one"), await labelId("two")]);

    expect(map.size).toBe(2);
    const names = [...map.values()].flatMap((proposal) =>
      proposal.rules.map((rule) => rule.artistName),
    );
    expect(names.sort()).toEqual(["First", "Second"]);
  });
});

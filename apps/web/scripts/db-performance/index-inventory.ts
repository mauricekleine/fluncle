import rawInventory from "./index-inventory.json";
import { SCALE_PROFILES, type ScaleProfile } from "./manifest";
import { type ContractReport, type PerformanceContract } from "./registry";

export const INDEX_AUDIT_PROFILES = [...SCALE_PROFILES] as const;

export type IndexDecision = "add" | "drop" | "keep";

export type IndexConsumerCoordinate = {
  file: string;
  marker: string;
};

export type IndexInventoryEntry = {
  columns: string[];
  decision: IndexDecision;
  finalConsumer: {
    coordinates: IndexConsumerCoordinate[];
    query: string;
  };
  knownContractMappings?: string[];
  migration?: string;
  name: string;
  partialPredicate: null | string;
  performanceContracts: {
    consumer: IndexConsumerCoordinate[];
    id: string;
    requiredProfiles: ScaleProfile[];
  }[];
  structuralRationale: string;
};

export type IndexInventoryDocument = {
  databaseScaleIndexes: IndexInventoryEntry[];
  inventoryKind: string;
  productionInventory: {
    currentFinalSchemaBeforeContraction: { indexes: number; tracksIndexes: number };
    finalSchemaAfterContraction: { indexes: number; tracksIndexes: number };
  };
  requiredProfiles: ScaleProfile[];
  schemaVersion: number;
  summary: {
    databaseScaleIndexes: number;
    decisions: Record<IndexDecision, number>;
    missingConsumers: number;
    missingProfileEvidence: number;
    planContractCount: number;
    totalIndexes: number;
    tracksIndexes: number;
  };
  tracksIndexes: IndexInventoryEntry[];
};

export type IndexEvidenceDefinition = {
  allowFullScanOf?: string;
  growingTable: string;
  inventoryEntry: IndexInventoryEntry;
  requiredIndexName: string;
};

export type IndexAuditContractEvidence = {
  contractId: string;
  metadata: Record<string, boolean | number | string | null> | null;
  observedProfile: ScaleProfile | null;
  passed: boolean;
  plan: {
    details: string[];
    fullScans: { detail: string; table: string }[];
    tempSorts: string[];
    violations: string[];
  } | null;
  requiredProfiles: ScaleProfile[];
  resultRowCount: ContractReport["resultRowCount"] | null;
};

export type IndexAuditEntry = {
  contracts: IndexAuditContractEvidence[];
  decision: IndexDecision;
  inventory: IndexInventoryEntry;
  name: string;
};

export type IndexAuditReport = {
  decisions: {
    byIndex: Record<string, IndexDecision>;
    counts: Record<IndexDecision, number>;
  };
  entries: IndexAuditEntry[];
  missingConsumers: string[];
  missingPlanEvidence: string[];
  missingProfileEvidence: string[];
  observedProfile: ScaleProfile;
  productionInventory: IndexInventoryDocument["productionInventory"];
  profileEvidence: Record<ScaleProfile, { declaredContracts: number; observedContracts: number }>;
  passed: boolean;
  totals: {
    databaseScaleIndexes: number;
    evidenceContracts: number;
    indexes: number;
    tracksIndexes: number;
  };
};

export const FINAL_INDEX_INVENTORY = rawInventory as unknown as IndexInventoryDocument;

export function allIndexInventoryEntries(
  inventory: IndexInventoryDocument = FINAL_INDEX_INVENTORY,
): IndexInventoryEntry[] {
  return [...inventory.tracksIndexes, ...inventory.databaseScaleIndexes];
}

export function validateIndexInventory(
  inventory: IndexInventoryDocument = FINAL_INDEX_INVENTORY,
): string[] {
  const entries = allIndexInventoryEntries(inventory);
  const failures: string[] = [];
  const names = new Set<string>();
  const contractIds = new Set<string>();
  const decisions: Record<IndexDecision, number> = { add: 0, drop: 0, keep: 0 };
  const approvedDrops = new Set([
    "artifact_change_checkpoints_running_idx",
    "artifact_change_consumers_compaction_idx",
    "artifact_changes_created_seq_idx",
    "operation_receipts_operation_audit_idx",
    "tracks_capture_priority_idx",
    "tracks_nearest_finding_score_idx",
  ]);

  if (inventory.inventoryKind !== "final-index-inventory") {
    failures.push("inventory kind is not final-index-inventory");
  }
  if (inventory.tracksIndexes.length !== 32) {
    failures.push(`expected 32 tracks indexes, found ${inventory.tracksIndexes.length}`);
  }
  if (inventory.databaseScaleIndexes.length !== 30) {
    failures.push(
      `expected 30 database-scale indexes, found ${inventory.databaseScaleIndexes.length}`,
    );
  }
  if (inventory.requiredProfiles.join(",") !== INDEX_AUDIT_PROFILES.join(",")) {
    failures.push("inventory required profiles are not exactly 1x, 2x, and 4x");
  }

  for (const entry of entries) {
    if (names.has(entry.name)) {
      failures.push(`duplicate index inventory entry: ${entry.name}`);
    }
    names.add(entry.name);
    decisions[entry.decision] += 1;

    if (entry.columns.length === 0) {
      failures.push(`${entry.name} has no indexed columns`);
    }
    if (entry.finalConsumer.coordinates.length === 0 || entry.finalConsumer.query.length === 0) {
      failures.push(`${entry.name} is missing its final consumer or query`);
    }
    if (
      entry.finalConsumer.coordinates.some(
        (coordinate) => coordinate.file.length === 0 || coordinate.marker.length === 0,
      )
    ) {
      failures.push(`${entry.name} has an empty final consumer coordinate`);
    }
    if (
      /no production|not located|schema test|keep conservatively/i.test(entry.finalConsumer.query)
    ) {
      failures.push(`${entry.name} does not name a verified production consumer`);
    }
    if (entry.structuralRationale.length === 0) {
      failures.push(`${entry.name} is missing its structural rationale`);
    }
    if (entry.performanceContracts.length === 0) {
      failures.push(`${entry.name} has no plan-evidence contract`);
    }

    for (const contract of entry.performanceContracts) {
      if (contractIds.has(contract.id)) {
        failures.push(`duplicate index plan contract: ${contract.id}`);
      }
      contractIds.add(contract.id);
      if (contract.requiredProfiles.join(",") !== INDEX_AUDIT_PROFILES.join(",")) {
        failures.push(`${entry.name} contract ${contract.id} is missing a required profile`);
      }
      if (
        contract.consumer.length === 0 ||
        contract.consumer.some(
          (coordinate) => coordinate.file.length === 0 || coordinate.marker.length === 0,
        )
      ) {
        failures.push(`${entry.name} contract ${contract.id} is missing its consumer coordinate`);
      }
    }

    if (entry.decision === "drop" && !approvedDrops.has(entry.name)) {
      failures.push(`unapproved dropped index: ${entry.name}`);
    }
    if (entry.decision === "add") {
      failures.push(`unexpected added index: ${entry.name}`);
    }
  }

  if (decisions.keep !== 56 || decisions.drop !== 6 || decisions.add !== 0) {
    failures.push(
      `final decisions are keep=${decisions.keep}, drop=${decisions.drop}, add=${decisions.add}`,
    );
  }
  const contractCount = entries.reduce(
    (total, entry) => total + entry.performanceContracts.length,
    0,
  );
  if (
    inventory.summary.totalIndexes !== entries.length ||
    inventory.summary.tracksIndexes !== inventory.tracksIndexes.length ||
    inventory.summary.databaseScaleIndexes !== inventory.databaseScaleIndexes.length
  ) {
    failures.push("inventory summary totals do not match its entries");
  }
  if (inventory.summary.planContractCount !== contractCount) {
    failures.push("inventory summary plan-contract total does not match its entries");
  }
  if (
    inventory.summary.decisions.keep !== decisions.keep ||
    inventory.summary.decisions.drop !== decisions.drop ||
    inventory.summary.decisions.add !== decisions.add
  ) {
    failures.push("inventory summary decisions do not match its entries");
  }
  if (inventory.summary.missingConsumers !== 0 || inventory.summary.missingProfileEvidence !== 0) {
    failures.push("inventory summary reports missing consumer or profile evidence");
  }
  if (inventory.productionInventory.currentFinalSchemaBeforeContraction.indexes !== 178) {
    failures.push("current final schema inventory count must be 178 indexes");
  }
  if (inventory.productionInventory.currentFinalSchemaBeforeContraction.tracksIndexes !== 32) {
    failures.push("current final schema track index count must be 32");
  }
  if (inventory.productionInventory.finalSchemaAfterContraction.indexes !== 172) {
    failures.push("final contracted schema inventory count must be 172 indexes");
  }
  if (inventory.productionInventory.finalSchemaAfterContraction.tracksIndexes !== 30) {
    failures.push("final contracted schema track index count must be 30");
  }

  return failures;
}

const inventoryFailures = validateIndexInventory();
if (inventoryFailures.length > 0) {
  throw new Error(`invalid final index inventory: ${inventoryFailures.join("; ")}`);
}

function evidenceFromReport(
  definition: IndexEvidenceDefinition,
  report: ContractReport | undefined,
  profile: ScaleProfile,
): IndexAuditContractEvidence {
  return {
    contractId:
      definition.inventoryEntry.performanceContracts.find(
        (reference) => report?.contractId === reference.id,
      )?.id ??
      definition.inventoryEntry.performanceContracts[0]?.id ??
      "missing",
    metadata: report?.metadata[0] ?? null,
    observedProfile: report ? profile : null,
    passed: report?.passed === true,
    plan: report?.plan
      ? {
          details: report.plan.details,
          fullScans: report.plan.fullScans,
          tempSorts: report.plan.tempSorts,
          violations: report.plan.violations,
        }
      : null,
    requiredProfiles:
      definition.inventoryEntry.performanceContracts.find(
        (reference) => reference.id === report?.contractId,
      )?.requiredProfiles ??
      definition.inventoryEntry.performanceContracts[0]?.requiredProfiles ??
      [],
    resultRowCount: report?.resultRowCount ?? null,
  };
}

export function buildIndexAudit(options: {
  contracts: readonly PerformanceContract[];
  inventory?: IndexInventoryDocument;
  profile: ScaleProfile;
  reports: readonly ContractReport[];
}): IndexAuditReport | null {
  const inventory = options.inventory ?? FINAL_INDEX_INVENTORY;
  const entries = allIndexInventoryEntries(inventory);
  const indexContracts = options.contracts.filter((contract) => contract.indexEvidence);

  if (indexContracts.length === 0) {
    return null;
  }

  const reportsById = new Map(options.reports.map((report) => [report.contractId, report]));
  const missingConsumers = entries
    .filter(
      (entry) =>
        entry.finalConsumer.coordinates.length === 0 ||
        entry.finalConsumer.coordinates.some(
          (coordinate) => coordinate.file.length === 0 || coordinate.marker.length === 0,
        ) ||
        entry.finalConsumer.query.length === 0,
    )
    .map((entry) => entry.name);
  const missingPlanEvidence: string[] = [];
  const missingProfileEvidence: string[] = [];
  const auditEntries: IndexAuditEntry[] = [];
  const decisionCounts: Record<IndexDecision, number> = { add: 0, drop: 0, keep: 0 };
  const decisionByIndex: Record<string, IndexDecision> = {};
  const profileEvidence = Object.fromEntries(
    INDEX_AUDIT_PROFILES.map((profile) => [
      profile,
      { declaredContracts: 0, observedContracts: 0 },
    ]),
  ) as Record<ScaleProfile, { declaredContracts: number; observedContracts: number }>;

  for (const entry of entries) {
    decisionCounts[entry.decision] += 1;
    decisionByIndex[entry.name] = entry.decision;
    const definitions = indexContracts.filter(
      (contract) => contract.indexEvidence?.inventoryEntry.name === entry.name,
    );
    const definitionById = new Map(
      definitions.flatMap((contract) => {
        const definition = contract.indexEvidence;
        return definition ? [[contract.id, definition] as const] : [];
      }),
    );
    const evidence: IndexAuditContractEvidence[] = [];
    const declaredProfiles = new Set<ScaleProfile>();

    for (const reference of entry.performanceContracts) {
      for (const profile of reference.requiredProfiles) {
        declaredProfiles.add(profile);
        profileEvidence[profile].declaredContracts += 1;
      }

      const definition = definitionById.get(reference.id);
      const report = reportsById.get(reference.id);
      if (!definition || !report) {
        missingPlanEvidence.push(`${entry.name}:${reference.id}`);
      }
      if (definition && report) {
        evidence.push(evidenceFromReport(definition, report, options.profile));
        profileEvidence[options.profile].observedContracts += 1;
      }
    }

    for (const profile of INDEX_AUDIT_PROFILES) {
      if (!declaredProfiles.has(profile)) {
        missingProfileEvidence.push(`${entry.name}:${profile}`);
      }
    }

    auditEntries.push({
      contracts: evidence,
      decision: entry.decision,
      inventory: entry,
      name: entry.name,
    });
  }

  const evidencePassed = auditEntries.every((entry) =>
    entry.contracts.every(
      (contract) =>
        contract.passed && contract.plan !== null && contract.plan.violations.length === 0,
    ),
  );

  return {
    decisions: { byIndex: decisionByIndex, counts: decisionCounts },
    entries: auditEntries,
    missingConsumers,
    missingPlanEvidence,
    missingProfileEvidence,
    observedProfile: options.profile,
    passed:
      missingConsumers.length === 0 &&
      missingPlanEvidence.length === 0 &&
      missingProfileEvidence.length === 0 &&
      evidencePassed,
    productionInventory: inventory.productionInventory,
    profileEvidence,
    totals: {
      databaseScaleIndexes: inventory.databaseScaleIndexes.length,
      evidenceContracts: entryContractCount(entries),
      indexes: entries.length,
      tracksIndexes: inventory.tracksIndexes.length,
    },
  };
}

function entryContractCount(entries: readonly IndexInventoryEntry[]): number {
  return entries.reduce((total, entry) => total + entry.performanceContracts.length, 0);
}

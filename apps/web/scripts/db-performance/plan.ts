export type ExplainPlanPolicy = {
  allowFullScanOf?: readonly string[];
  forbidTempSort?: boolean;
  growingTables?: readonly string[];
  requiredDetails?: readonly RegExp[];
};

export type ExplainPlanAnalysis = {
  details: string[];
  fullScans: { detail: string; table: string }[];
  tempSorts: string[];
  violations: string[];
};

function normalizeIdentifier(identifier: string): string {
  return identifier
    .replace(/^[`"[]/, "")
    .replace(/[`"\]]$/, "")
    .toLowerCase();
}

function scannedTable(detail: string): string | undefined {
  const match = /\bSCAN\s+(?:TABLE\s+)?([`"[]?[a-zA-Z_][\w.-]*[`"\]]?)/i.exec(detail);
  const candidate = match?.[1];

  if (!candidate || /^(constant|subquery)$/i.test(candidate)) {
    return undefined;
  }

  return normalizeIdentifier(candidate);
}

export function analyzeExplainPlan(
  details: readonly string[],
  policy: ExplainPlanPolicy = {},
): ExplainPlanAnalysis {
  const fullScans = details.flatMap((detail) => {
    const table = scannedTable(detail);

    return table ? [{ detail, table }] : [];
  });
  const tempSorts = details.filter((detail) => /USE TEMP B-TREE/i.test(detail));
  const allow = new Set((policy.allowFullScanOf ?? []).map(normalizeIdentifier));
  const growing = new Set((policy.growingTables ?? []).map(normalizeIdentifier));
  const violations: string[] = [];

  for (const scan of fullScans) {
    if (growing.has(scan.table) && !allow.has(scan.table)) {
      violations.push(`forbidden full scan of growing table ${scan.table}: ${scan.detail}`);
    }
  }

  if (policy.forbidTempSort && tempSorts.length > 0) {
    violations.push(...tempSorts.map((detail) => `forbidden temporary sort: ${detail}`));
  }

  for (const pattern of policy.requiredDetails ?? []) {
    if (!details.some((detail) => pattern.test(detail))) {
      violations.push(`required plan detail was absent: ${pattern.source}`);
    }
  }

  return { details: [...details], fullScans, tempSorts, violations };
}

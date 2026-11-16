export type ExplainPlanPolicy = {
  accessPaths?: readonly {
    table: string;
    minimumSearches?: number;
    paths: readonly { index: string; equalityPrefix: readonly string[] }[];
  }[];
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

  for (const access of policy.accessPaths ?? []) {
    const searches = details.flatMap((detail) => {
      const table = /\bSEARCH\s+(?:TABLE\s+)?(\S+)/i.exec(detail)?.[1];
      if (!table || normalizeIdentifier(table) !== normalizeIdentifier(access.table)) {
        return [];
      }
      const match = /\bUSING\s+(?:COVERING\s+)?INDEX\s+(\S+)\s*\(([^)]*)\)/i.exec(detail);
      return [
        {
          detail,
          index: normalizeIdentifier(match?.[1] ?? ""),
          terms: (match?.[2] ?? "").split(/\s+AND\s+/i),
        },
      ];
    });
    if (searches.length < (access.minimumSearches ?? 1)) {
      violations.push(`required indexed search of ${access.table} was absent`);
    }
    for (const search of searches) {
      const allowed = access.paths.some(
        (path) =>
          normalizeIdentifier(path.index) === search.index &&
          path.equalityPrefix.every((column, i) => {
            const term = /^\s*([^\s=]+)\s*=\s*\?\s*$/.exec(search.terms[i] ?? "");
            return (
              term !== null && normalizeIdentifier(term[1] ?? "") === normalizeIdentifier(column)
            );
          }),
      );
      if (!allowed) {
        violations.push(`forbidden access path for ${access.table}: ${search.detail}`);
      }
    }
  }

  return { details: [...details], fullScans, tempSorts, violations };
}

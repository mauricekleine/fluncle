import { parseSync, visitorKeys } from "oxc-parser";

export const DUE_WORK_ELIGIBILITY_TABLES = [
  "albums",
  "artist_aliases",
  "artist_centroids",
  "artist_socials",
  "artists",
  "findings",
  "label_aliases",
  "labels",
  "track_artists",
  "track_duplicate_keys",
  "track_embeddings",
  "tracks",
] as const;
export const GOAL_D_SOURCE_TABLES = [
  "artist_rules",
  "crawl_frontier",
  "findings",
  "labels",
  "track_artists",
  "tracks",
] as const;

export type DueWorkEligibilityTable = (typeof DUE_WORK_ELIGIBILITY_TABLES)[number];
export type DueWorkMutationTable =
  | "artist_rules"
  | "crawl_frontier"
  | "dynamic"
  | DueWorkEligibilityTable;
export type DueWorkMutationOperation = "delete" | "insert" | "update";
export type DueWorkMutationCoupling = "source-helper" | "write-batch" | "write-transaction";

export type DueWorkMutationSite = {
  column: number;
  coupling: DueWorkMutationCoupling | null;
  file: string;
  id: string;
  line: number;
  operation: DueWorkMutationOperation;
  projectionCoupling: DueWorkMutationCoupling | null;
  table: DueWorkMutationTable;
};

export type DueWorkDelegatedCallSite = {
  column: number;
  coupling: DueWorkMutationCoupling | null;
  file: string;
  id: string;
  name: string;
  owner: null | string;
  line: number;
};

type AstNode = { end: number; start: number; type: string; [key: string]: unknown };

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const SOURCE_HELPER = "batchDueWorkSourceMutation";
const DUE_WORK_MARKER_HELPERS = new Set([
  "markDueWorkSourceMaintenanceFromSelectStatements",
  "markDueWorkSourceMaintenanceStatements",
  "markDueWorkSourceRepairsFromSelectStatement",
  "markDueWorkSourceRepairsStatement",
]);
const PUBLIC_PROJECTION_MARKER_HELPERS = new Set([
  "markDueWorkSourceMaintenanceFromSelectStatements",
  "markDueWorkSourceMaintenanceStatements",
  "markPublicProjectionSourceChangedFromSelectStatements",
  "markPublicProjectionSourceChangedStatements",
]);
const GOAL_D_PROJECTION_MARKER_HELPERS = new Set([
  ...PUBLIC_PROJECTION_MARKER_HELPERS,
  "markCrawlNodeRepairStatement",
  "markCrawlNodeRepairsByUpdatedAtStatement",
  "markCrawlProjectionRepairStatement",
  "markCrawlProjectionRepairsFromSelectStatement",
]);
const TABLE_PATTERN = DUE_WORK_ELIGIBILITY_TABLES.join("|");
const MUTATION_PATTERN = new RegExp(
  `\\b(insert\\s+(?:or\\s+\\w+\\s+)?into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+(?:["'\\x60]?(?:main\\.)?)(${TABLE_PATTERN}\\b|\\$\\{\\})`,
  "gi",
);
const GOAL_D_TABLE_PATTERN = GOAL_D_SOURCE_TABLES.join("|");
const GOAL_D_MUTATION_PATTERN = new RegExp(
  `\\b(insert\\s+(?:or\\s+\\w+\\s+)?into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+(?:["'\\x60]?(?:main\\.)?)(${GOAL_D_TABLE_PATTERN}\\b|\\$\\{\\})`,
  "gi",
);

function astNode(value: unknown): value is AstNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { end?: unknown; start?: unknown; type?: unknown };
  return (
    typeof candidate.type === "string" &&
    typeof candidate.start === "number" &&
    typeof candidate.end === "number"
  );
}

function childNodes(node: AstNode): AstNode[] {
  const keys = visitorKeys[node.type] ?? [];
  return keys.flatMap((key) => {
    const value = node[key];
    if (Array.isArray(value)) {
      return value.filter(astNode);
    }
    return astNode(value) ? [value] : [];
  });
}

function walk(node: AstNode, visit: (candidate: AstNode) => boolean | void): void {
  if (visit(node) === false) {
    return;
  }
  for (const child of childNodes(node)) {
    walk(child, visit);
  }
}

function buildParents(root: AstNode): WeakMap<AstNode, AstNode> {
  const parents = new WeakMap<AstNode, AstNode>();
  walk(root, (node) => {
    for (const child of childNodes(node)) {
      parents.set(child, node);
    }
  });
  return parents;
}

function unwrapExpression(expression: AstNode): AstNode {
  let current = expression;
  while (true) {
    const nested =
      current.type === "AwaitExpression"
        ? current.argument
        : [
              "ParenthesizedExpression",
              "TSAsExpression",
              "TSSatisfiesExpression",
              "TSTypeAssertion",
            ].includes(current.type)
          ? current.expression
          : null;
    if (!astNode(nested)) {
      return current;
    }
    current = nested;
  }
}

function identifierName(node: unknown): null | string {
  return astNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : null;
}

function callName(call: AstNode): null | string {
  if (call.type !== "CallExpression" || !astNode(call.callee)) {
    return null;
  }
  const callee = unwrapExpression(call.callee);
  const direct = identifierName(callee);
  if (direct !== null) {
    return direct;
  }
  return callee.type === "MemberExpression" ? identifierName(callee.property) : null;
}

function callReceiver(call: AstNode): null | AstNode {
  if (call.type !== "CallExpression" || !astNode(call.callee)) {
    return null;
  }
  const callee = unwrapExpression(call.callee);
  return callee.type === "MemberExpression" && astNode(callee.object) ? callee.object : null;
}

function callArguments(call: AstNode): AstNode[] {
  return call.type === "CallExpression" && Array.isArray(call.arguments)
    ? call.arguments.filter(astNode)
    : [];
}

function staticText(node: AstNode): null | string {
  if (
    (node.type === "Literal" || node.type === "StringLiteral") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  if (node.type !== "TemplateLiteral" || !Array.isArray(node.quasis)) {
    return null;
  }
  return node.quasis
    .filter(astNode)
    .map((quasi, index) => {
      const value = quasi.value as { cooked?: unknown; raw?: unknown } | undefined;
      const text =
        typeof value?.cooked === "string"
          ? value.cooked
          : typeof value?.raw === "string"
            ? value.raw
            : "";
      return index === 0 ? text : `\${}${text}`;
    })
    .join("");
}

function operation(value: string): DueWorkMutationOperation {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("insert")) {
    return "insert";
  }
  if (normalized.startsWith("delete")) {
    return "delete";
  }
  return "update";
}

function fingerprint(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function enclosingScope(node: AstNode, parents: WeakMap<AstNode, AstNode>): AstNode {
  let current = parents.get(node);
  while (current !== undefined) {
    if (FUNCTION_TYPES.has(current.type) || current.type === "Program") {
      return current;
    }
    current = parents.get(current);
  }
  return node;
}

function visitScope(scope: AstNode, visit: (node: AstNode) => void): void {
  walk(scope, (node) => {
    if (node !== scope && FUNCTION_TYPES.has(node.type)) {
      return false;
    }
    visit(node);
  });
}

function contains(container: AstNode, target: AstNode): boolean {
  return container.start <= target.start && container.end >= target.end;
}

function bindingNameForNode(
  node: AstNode,
  scope: AstNode,
  parents: WeakMap<AstNode, AstNode>,
): null | string {
  let current: AstNode | undefined = node;
  while (current !== undefined && current !== scope) {
    if (current.type === "VariableDeclarator") {
      const name = identifierName(current.id);
      if (name !== null) {
        return name;
      }
    }
    if (current.type === "AssignmentExpression") {
      const name = identifierName(current.left);
      if (name !== null) {
        return name;
      }
    }
    if (current.type === "CallExpression" && callName(current) === "push") {
      const receiver = callReceiver(current);
      const name = identifierName(receiver);
      if (name !== null) {
        return name;
      }
    }
    current = parents.get(current);
  }
  return null;
}

function collectionParts(expression: AstNode, scope: AstNode): AstNode[] {
  const value = unwrapExpression(expression);
  const parts: AstNode[] = [value];
  const collectionName = identifierName(value);
  if (collectionName === null) {
    return parts;
  }

  visitScope(scope, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      identifierName(node.id) === collectionName &&
      astNode(node.init)
    ) {
      parts.push(node.init);
      return;
    }
    if (node.type === "CallExpression" && callName(node) === "push") {
      const receiver = callReceiver(node);
      if (identifierName(receiver) === collectionName) {
        parts.push(...callArguments(node));
      }
    }
  });
  return parts;
}

function collectionContains(
  expression: AstNode,
  mutationNode: AstNode,
  scope: AstNode,
  parents: WeakMap<AstNode, AstNode>,
): boolean {
  if (collectionParts(expression, scope).some((part) => contains(part, mutationNode))) {
    return true;
  }
  const bindingName = bindingNameForNode(mutationNode, scope, parents);
  if (bindingName === null) {
    return false;
  }
  return collectionParts(expression, scope).some((part) => {
    let found = false;
    walk(part, (candidate) => {
      if (identifierName(candidate) === bindingName) {
        found = true;
        return false;
      }
    });
    return found;
  });
}

function declarationName(node: AstNode): null | string {
  if (node.type === "FunctionDeclaration") {
    return identifierName(node.id);
  }
  if (
    node.type === "VariableDeclarator" &&
    astNode(node.init) &&
    FUNCTION_TYPES.has(node.init.type)
  ) {
    return identifierName(node.id);
  }
  return null;
}

function enclosingFunctionName(node: AstNode, parents: WeakMap<AstNode, AstNode>): null | string {
  let current = parents.get(node);
  while (current !== undefined) {
    if (FUNCTION_TYPES.has(current.type)) {
      if (current.type === "FunctionDeclaration") {
        return identifierName(current.id);
      }
      const parent = parents.get(current);
      const name = parent?.type === "VariableDeclarator" ? identifierName(parent.id) : null;
      if (name !== null) {
        return name;
      }
    }
    current = parents.get(current);
  }
  return null;
}

function functionContainsMarker(
  call: AstNode,
  program: AstNode,
  markerHelpers: ReadonlySet<string>,
): boolean {
  const name = callName(call);
  if (name === null) {
    return false;
  }
  let found = false;
  walk(program, (node) => {
    const propertyName =
      node.type === "Property" && astNode(node.value) && FUNCTION_TYPES.has(node.value.type)
        ? identifierName(node.key)
        : null;
    if (declarationName(node) !== name && propertyName !== name) {
      return;
    }
    walk(node, (candidate) => {
      if (candidate.type === "CallExpression" && markerHelpers.has(callName(candidate) ?? "")) {
        found = true;
      }
    });
  });
  return found;
}

function partsContainMarker(
  parts: readonly AstNode[],
  program: AstNode,
  markerHelpers: ReadonlySet<string>,
): boolean {
  let found = false;
  for (const part of parts) {
    walk(part, (node) => {
      if (
        node.type === "CallExpression" &&
        (markerHelpers.has(callName(node) ?? "") ||
          functionContainsMarker(node, program, markerHelpers))
      ) {
        found = true;
        return false;
      }
    });
    if (found) {
      return true;
    }
  }
  return false;
}

function stringValue(node: AstNode | undefined): null | string {
  return (node?.type === "Literal" || node?.type === "StringLiteral") &&
    typeof node.value === "string"
    ? node.value
    : null;
}

function isWriteBatch(call: AstNode): boolean {
  if (callName(call) !== "batch" || callArguments(call)[0] === undefined) {
    return false;
  }
  const mode = callArguments(call)[1];
  return mode === undefined || stringValue(mode) === "write";
}

function isWriteTransactionBinding(name: string, scope: AstNode): boolean {
  let found = false;
  visitScope(scope, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      identifierName(node.id) !== name ||
      !astNode(node.init)
    ) {
      return;
    }
    const initializer = unwrapExpression(node.init);
    if (
      initializer.type === "CallExpression" &&
      callName(initializer) === "transaction" &&
      stringValue(callArguments(initializer)[0]) === "write"
    ) {
      found = true;
    }
  });
  return found;
}

function mutationCoupling(
  node: AstNode,
  program: AstNode,
  parents: WeakMap<AstNode, AstNode>,
  markerHelpers: ReadonlySet<string>,
): DueWorkMutationCoupling | null {
  const scope = enclosingScope(node, parents);
  let coupling: DueWorkMutationCoupling | null = null;

  visitScope(scope, (candidate) => {
    if (coupling !== null || candidate.type !== "CallExpression") {
      return;
    }
    const arguments_ = callArguments(candidate);
    const firstArgument = arguments_[0];
    const statementsArgument = arguments_[1];
    if (
      callName(candidate) === SOURCE_HELPER &&
      statementsArgument !== undefined &&
      collectionContains(statementsArgument, node, scope, parents)
    ) {
      coupling = "source-helper";
      return;
    }
    if (
      isWriteBatch(candidate) &&
      firstArgument !== undefined &&
      collectionContains(firstArgument, node, scope, parents) &&
      partsContainMarker(collectionParts(firstArgument, scope), program, markerHelpers)
    ) {
      coupling = "write-batch";
    }
  });
  if (coupling !== null) {
    return coupling;
  }

  visitScope(scope, (candidate) => {
    if (
      coupling !== null ||
      candidate.type !== "CallExpression" ||
      callName(candidate) !== "execute"
    ) {
      return;
    }
    const receiverName = identifierName(callReceiver(candidate));
    const statement = callArguments(candidate)[0];
    if (
      receiverName === null ||
      statement === undefined ||
      !collectionContains(statement, node, scope, parents) ||
      !isWriteTransactionBinding(receiverName, scope)
    ) {
      return;
    }

    visitScope(scope, (batchCandidate) => {
      if (
        coupling !== null ||
        batchCandidate.type !== "CallExpression" ||
        callName(batchCandidate) !== "batch"
      ) {
        return;
      }
      const batchStatements = callArguments(batchCandidate)[0];
      if (
        identifierName(callReceiver(batchCandidate)) === receiverName &&
        batchStatements !== undefined &&
        partsContainMarker(collectionParts(batchStatements, scope), program, markerHelpers)
      ) {
        coupling = "write-transaction";
      }
    });
  });
  return coupling;
}

function lineAndColumn(sourceText: string, offset: number): { column: number; line: number } {
  const before = sourceText.slice(0, offset);
  const lines = before.split("\n");
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length };
}

function auditMutationSites(
  file: string,
  sourceText: string,
  mutationPattern: RegExp,
  projectionMarkerHelpers: ReadonlySet<string>,
): DueWorkMutationSite[] {
  const parsed = parseSync(file, sourceText, { astType: "ts", lang: "ts", range: false });
  if (parsed.errors.some((error) => error.severity === "Error")) {
    throw new Error(
      `could not parse ${file}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const program = parsed.program as unknown as AstNode;
  const parents = buildParents(program);
  const rawSites: Array<
    Omit<DueWorkMutationSite, "coupling" | "id" | "projectionCoupling"> & {
      node: AstNode;
      sql: string;
    }
  > = [];

  walk(program, (node) => {
    const sql = staticText(node);
    if (sql === null) {
      return;
    }
    mutationPattern.lastIndex = 0;
    for (const match of sql.matchAll(mutationPattern)) {
      const rawTable = match[2]?.toLowerCase();
      const table = (rawTable === "${}" ? "dynamic" : rawTable) as DueWorkMutationTable | undefined;
      const verb = match[1];
      if (table === undefined || verb === undefined) {
        continue;
      }
      rawSites.push({
        ...lineAndColumn(sourceText, node.start),
        file,
        node,
        operation: operation(verb),
        sql,
        table,
      });
    }
  });

  const duplicateCounts = new Map<string, number>();
  return rawSites.map(({ node, sql, ...site }) => {
    const base = `${file}:${site.operation}:${site.table}:${fingerprint(sql)}`;
    const occurrence = (duplicateCounts.get(base) ?? 0) + 1;
    duplicateCounts.set(base, occurrence);
    return {
      ...site,
      coupling: mutationCoupling(node, program, parents, DUE_WORK_MARKER_HELPERS),
      id: occurrence === 1 ? base : `${base}:${occurrence}`,
      projectionCoupling: mutationCoupling(node, program, parents, projectionMarkerHelpers),
    };
  });
}

export function auditDueWorkMutationSites(file: string, sourceText: string): DueWorkMutationSite[] {
  return auditMutationSites(file, sourceText, MUTATION_PATTERN, PUBLIC_PROJECTION_MARKER_HELPERS);
}

export function auditGoalDMutationSites(file: string, sourceText: string): DueWorkMutationSite[] {
  return auditMutationSites(
    file,
    sourceText,
    GOAL_D_MUTATION_PATTERN,
    GOAL_D_PROJECTION_MARKER_HELPERS,
  );
}

export function auditDueWorkDelegatedCallSites(
  file: string,
  sourceText: string,
  names: ReadonlySet<string>,
): DueWorkDelegatedCallSite[] {
  const parsed = parseSync(file, sourceText, { astType: "ts", lang: "ts", range: false });
  if (parsed.errors.some((error) => error.severity === "Error")) {
    throw new Error(
      `could not parse ${file}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const program = parsed.program as unknown as AstNode;
  const parents = buildParents(program);
  const calls: DueWorkDelegatedCallSite[] = [];
  const counts = new Map<string, number>();

  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const name = callName(node);
    if (name === null || !names.has(name)) {
      return;
    }
    const base = `${file}:call:${name}`;
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    calls.push({
      ...lineAndColumn(sourceText, node.start),
      coupling: mutationCoupling(node, program, parents, DUE_WORK_MARKER_HELPERS),
      file,
      id: occurrence === 1 ? base : `${base}:${occurrence}`,
      name,
      owner: enclosingFunctionName(node, parents),
    });
  });
  return calls;
}

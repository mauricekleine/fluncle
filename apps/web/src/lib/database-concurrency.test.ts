import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import {
  CATALOGUE_PUBLIC_ENTITY_COUNT_DB_CONCURRENCY,
  LOCAL_DB_CONCURRENCY,
  PRIMARY_DB_CONCURRENCY,
  REMOTE_DB_CONCURRENCY,
  TELEMETRY_DB_CONCURRENCY,
} from "./database-concurrency";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SOURCE_EXTENSIONS = [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"];
const WRAPPER_EXPRESSIONS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

type AstNode = Record<string, unknown>;
type SourceInfo = { ast: AstNode; file: string; source: string };
type Binding = { file: string; importedName?: string; node?: AstNode };
type CallSite = { file: string; functionName: string | undefined; line: number; node: AstNode };

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

function trackedSourcePaths(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  return output
    .split("\0")
    .filter((file) => file.length > 0 && isSourceFile(file))
    .map((file) => resolve(REPO_ROOT, file));
}

function lineOf(source: string, offset: number): number {
  let line = 1;

  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
    }
  }

  return line;
}

function propertyName(node: AstNode | undefined): string | undefined {
  if (node === undefined || node.computed === true) {
    return undefined;
  }

  const key = isAstNode(node.key) ? node.key : undefined;

  if (key?.type === "Identifier" && typeof key.name === "string") {
    return key.name;
  }

  if (key?.type === "Literal" && key.value === "concurrency") {
    return "concurrency";
  }

  return undefined;
}

function unwrap(node: AstNode | undefined): AstNode | undefined {
  let current = node;

  while (current !== undefined && WRAPPER_EXPRESSIONS.has(String(current.type))) {
    current = isAstNode(current.expression) ? current.expression : undefined;
  }

  return current;
}

function possibleConfigBranches(node: AstNode | undefined): Array<AstNode | undefined> {
  const current = unwrap(node);

  if (current === undefined) {
    return [undefined];
  }

  if (current.type === "ObjectExpression") {
    return [current];
  }

  if (current.type === "ConditionalExpression") {
    return [
      ...possibleConfigBranches(isAstNode(current.consequent) ? current.consequent : undefined),
      ...possibleConfigBranches(isAstNode(current.alternate) ? current.alternate : undefined),
    ];
  }

  if (current.type === "SequenceExpression") {
    const expressions = Array.isArray(current.expressions) ? current.expressions : [];
    const last = expressions.at(-1);

    return possibleConfigBranches(isAstNode(last) ? last : undefined);
  }

  return [undefined];
}

function concurrencyExpression(config: AstNode): AstNode | undefined {
  const properties = Array.isArray(config.properties) ? config.properties : [];
  let expression: AstNode | undefined;
  let propertyIndex = -1;

  for (const [index, candidate] of properties.entries()) {
    if (!isAstNode(candidate)) {
      continue;
    }

    if (candidate.type === "Property" && propertyName(candidate) === "concurrency") {
      expression = isAstNode(candidate.value) ? candidate.value : undefined;
      propertyIndex = index;
    }
  }

  if (expression === undefined) {
    return undefined;
  }

  // An unexamined spread after the explicit property could overwrite it and
  // silently restore libSQL's default, so that branch is deliberately unknown.
  for (const candidate of properties.slice(propertyIndex + 1)) {
    if (isAstNode(candidate) && candidate.type === "SpreadElement") {
      return undefined;
    }
  }

  return expression;
}

function walk(
  node: unknown,
  visit: (node: AstNode, ancestors: AstNode[]) => void,
  ancestors: AstNode[] = [],
): void {
  if (!isAstNode(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child, visit, ancestors);
      }
    }

    return;
  }

  visit(node, ancestors);

  const nextAncestors = [...ancestors, node];
  for (const [key, child] of Object.entries(node)) {
    if (key !== "type" && key !== "start" && key !== "end") {
      walk(child, visit, nextAncestors);
    }
  }
}

function functionName(node: AstNode): string | undefined {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    const id = isAstNode(node.id) ? node.id : undefined;

    return typeof id?.name === "string" ? id.name : undefined;
  }

  return undefined;
}

function parseSource(file: string): SourceInfo {
  const source = readFileSync(file, "utf8");
  const parsed = parseSync(file, source, { sourceType: "unambiguous" });

  if (parsed.errors.length > 0) {
    throw new Error(
      `database concurrency scan could not parse ${relative(REPO_ROOT, file)}: ${parsed.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  return { ast: parsed.program as unknown as AstNode, file, source };
}

function collectCallSites(sources: SourceInfo[]): CallSite[] {
  const callSites: CallSite[] = [];

  for (const { ast, file, source } of sources) {
    walk(ast, (node, ancestors) => {
      if (node.type !== "CallExpression") {
        return;
      }

      const callee = isAstNode(node.callee) ? node.callee : undefined;
      if (callee?.type !== "Identifier" || callee.name !== "createClient") {
        return;
      }

      let currentFunction: string | undefined;
      for (const ancestor of ancestors) {
        const name = functionName(ancestor);
        if (name !== undefined) {
          currentFunction = name;
        }
      }

      callSites.push({
        file,
        functionName: currentFunction,
        line: lineOf(source, typeof node.start === "number" ? node.start : 0),
        node,
      });
    });
  }

  return callSites;
}

function expectedConcurrency(call: CallSite): number {
  const relativeFile = relative(REPO_ROOT, call.file);

  if (relativeFile === "apps/web/src/lib/server/db.ts") {
    if (call.functionName === "getDb") {
      return 4;
    }

    if (call.functionName === "getTelemetryDb") {
      return 3;
    }
  }

  if (relativeFile === "apps/web/scripts/count-catalogue-public-entities.ts") {
    return 3;
  }

  return 1;
}

function resolveImportPath(file: string, source: string, paths: Set<string>): string | undefined {
  if (!source.startsWith(".")) {
    return undefined;
  }

  const base = resolve(dirname(file), source);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];

  return candidates.find((candidate) => paths.has(candidate) || existsSync(candidate));
}

function collectBindings(sourceInfo: SourceInfo, paths: Set<string>): Map<string, Binding> {
  const bindings = new Map<string, Binding>();

  walk(sourceInfo.ast, (node) => {
    if (node.type === "VariableDeclarator") {
      const id = isAstNode(node.id) ? node.id : undefined;
      if (id?.type === "Identifier" && typeof id.name === "string") {
        bindings.set(id.name, {
          file: sourceInfo.file,
          node: unwrap(isAstNode(node.init) ? node.init : undefined),
        });
      }
    }

    if (node.type !== "ImportDeclaration" || !isAstNode(node.source)) {
      return;
    }

    const sourceValue = node.source.value;
    if (typeof sourceValue !== "string") {
      return;
    }

    const importedFile = resolveImportPath(sourceInfo.file, sourceValue, paths);
    if (importedFile === undefined || !Array.isArray(node.specifiers)) {
      return;
    }

    for (const specifier of node.specifiers) {
      if (!isAstNode(specifier) || specifier.importKind === "type") {
        continue;
      }

      const local = isAstNode(specifier.local) ? specifier.local.name : undefined;
      if (typeof local !== "string") {
        continue;
      }

      const imported = isAstNode(specifier.imported) ? specifier.imported : undefined;
      const importedName =
        typeof imported?.name === "string"
          ? imported.name
          : typeof imported?.value === "string"
            ? imported.value
            : undefined;
      if (importedName !== undefined) {
        bindings.set(local, { file: importedFile, importedName });
      }
    }
  });

  return bindings;
}

function resolveNumericValue(
  expression: AstNode | undefined,
  sourceInfo: SourceInfo,
  paths: Set<string>,
  cache: Map<string, SourceInfo>,
  seen: Set<string>,
): number | undefined {
  const node = unwrap(expression);
  if (node === undefined) {
    return undefined;
  }

  if (node.type === "Literal" && typeof node.value === "number") {
    return node.value;
  }

  if (node.type === "UnaryExpression" && (node.operator === "+" || node.operator === "-")) {
    const value = resolveNumericValue(
      isAstNode(node.argument) ? node.argument : undefined,
      sourceInfo,
      paths,
      cache,
      seen,
    );

    return value === undefined ? undefined : node.operator === "-" ? -value : value;
  }

  if (node.type !== "Identifier" || typeof node.name !== "string") {
    return undefined;
  }

  const bindingKey = `${sourceInfo.file}:${node.name}`;
  if (seen.has(bindingKey)) {
    return undefined;
  }

  const bindings = collectBindings(sourceInfo, paths);
  const binding = bindings.get(node.name);
  if (binding === undefined) {
    return undefined;
  }

  seen.add(bindingKey);

  if (binding.importedName !== undefined) {
    const importedInfo = cache.get(binding.file) ?? parseSource(binding.file);
    cache.set(binding.file, importedInfo);

    return resolveExportedNumericValue(importedInfo, binding.importedName, paths, cache, seen);
  }

  return resolveNumericValue(binding.node, sourceInfo, paths, cache, seen);
}

function resolveExportedNumericValue(
  sourceInfo: SourceInfo,
  exportedName: string,
  paths: Set<string>,
  cache: Map<string, SourceInfo>,
  seen: Set<string>,
): number | undefined {
  let value: AstNode | undefined;

  walk(sourceInfo.ast, (node) => {
    if (node.type === "VariableDeclarator") {
      const id = isAstNode(node.id) ? node.id : undefined;
      if (id?.type === "Identifier" && id.name === exportedName) {
        value = unwrap(isAstNode(node.init) ? node.init : undefined);
      }
    }

    if (node.type !== "ExportNamedDeclaration") {
      return;
    }

    const declaration = isAstNode(node.declaration) ? node.declaration : undefined;
    if (declaration?.type === "VariableDeclaration" && Array.isArray(declaration.declarations)) {
      for (const declarator of declaration.declarations) {
        if (!isAstNode(declarator)) {
          continue;
        }

        const id = isAstNode(declarator.id) ? declarator.id : undefined;
        if (id?.type === "Identifier" && id.name === exportedName) {
          value = unwrap(isAstNode(declarator.init) ? declarator.init : undefined);
        }
      }
    }

    if (Array.isArray(node.specifiers)) {
      for (const specifier of node.specifiers) {
        if (!isAstNode(specifier)) {
          continue;
        }

        const exportName = isAstNode(specifier.exported) ? specifier.exported : undefined;
        const localName = isAstNode(specifier.local) ? specifier.local : undefined;
        if (exportName?.name === exportedName && typeof localName?.name === "string") {
          value = { name: localName.name, type: "Identifier" };
        }
      }
    }
  });

  return resolveNumericValue(value, sourceInfo, paths, cache, seen);
}

function describeCall(call: CallSite): string {
  return `${relative(REPO_ROOT, call.file)}:${call.line}`;
}

describe("database concurrency bounds", () => {
  it("pins the shared vocabulary", () => {
    expect(PRIMARY_DB_CONCURRENCY).toBe(4);
    expect(TELEMETRY_DB_CONCURRENCY).toBe(3);
    expect(CATALOGUE_PUBLIC_ENTITY_COUNT_DB_CONCURRENCY).toBe(3);
    expect(REMOTE_DB_CONCURRENCY).toBe(1);
    expect(LOCAL_DB_CONCURRENCY).toBe(1);
  });

  it("gives every tracked createClient config branch an explicit nonzero bound", () => {
    const paths = trackedSourcePaths();
    // Read every tracked source, including dot directories. This cheap candidate
    // filter avoids parsing unrelated workflow DSL files; AST traversal below,
    // rather than a regex, discovers the actual calls in each candidate.
    const sourceInfos = paths
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => source.includes("createClient"))
      .map(({ file }) => parseSource(file));
    const callSites = collectCallSites(sourceInfos);
    const cache = new Map(sourceInfos.map((sourceInfo) => [sourceInfo.file, sourceInfo]));
    const pathSet = new Set(paths);

    expect(callSites.length).toBeGreaterThan(0);
    expect(
      callSites.filter(({ file }) =>
        relative(REPO_ROOT, file).includes("fluncle-catalogue-prune/scripts/lib.ts"),
      ),
    ).toHaveLength(2);

    const violations: string[] = [];

    for (const call of callSites) {
      const args = Array.isArray(call.node.arguments) ? call.node.arguments : [];
      const branches = possibleConfigBranches(isAstNode(args[0]) ? args[0] : undefined);

      expect(branches.length, `${describeCall(call)} has no config branch`).toBeGreaterThan(0);

      for (const [branchIndex, branch] of branches.entries()) {
        const expression = branch === undefined ? undefined : concurrencyExpression(branch);
        const value = resolveNumericValue(
          expression,
          cache.get(call.file) ?? parseSource(call.file),
          pathSet,
          cache,
          new Set(),
        );
        const location = describeCall(call);

        if (expression === undefined) {
          violations.push(
            `${location} branch ${branchIndex} lacks an explicit concurrency property`,
          );
        } else if (value === undefined) {
          violations.push(`${location} branch ${branchIndex} has an unknown concurrency value`);
        } else if (value <= 0) {
          violations.push(
            `${location} branch ${branchIndex} must use a positive concurrency value`,
          );
        } else if (value !== expectedConcurrency(call)) {
          violations.push(
            `${location} branch ${branchIndex} uses ${value}; expected ${expectedConcurrency(call)}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

import { join } from "node:path";

// Scan canonical test sources only. Generated `.agents` copies are installed from
// `packages/skills` and are checked by `skills:install`, not treated as another source.
const TEST_ROOTS = ["packages", "apps", "docs/agents/hermes/scripts", "scripts", ".claude/hooks"];
const MODULES = new Set(["node:fs", "node:fs/promises"]);

type Token = {
  end: number;
  start: number;
  text: string;
};

type Delimiters = Map<number, number>;

type Allocation = {
  file: string;
  line: number;
  owner: string;
};

export type TempDirCleanupViolation = Allocation & {
  reason: string;
};

type Bindings = {
  allocationNames: Set<string>;
  allocationNamespaces: Set<string>;
  removalNames: Set<string>;
  removalNamespaces: Set<string>;
};

type Call = {
  index: number;
  openIndex: number;
};

type Cleanup = Call & {
  argument: string;
  recursive: boolean;
};

type RegistryPush = {
  argument: string;
  registry: string;
};

type ForOf = {
  bodyEnd: number;
  bodyStart: number;
  registry: string;
  variable: string;
};

type Range = {
  end: number;
  start: number;
};

function isIdentifier(text: string | undefined): text is string {
  return text !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text);
}

function isStringLiteral(text: string | undefined): boolean {
  return (
    text !== undefined &&
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  );
}

function stringLiteralValue(text: string | undefined): string | undefined {
  return isStringLiteral(text) ? text.slice(1, -1) : undefined;
}

function tokensFor(source: string): Token[] {
  const tokens: Token[] = [];
  let previousText: string | undefined;

  const addToken = (start: number, end: number): void => {
    const text = source.slice(start, end);
    tokens.push({ end, start, text });
    previousText = text;
  };

  const skipQuoted = (start: number, quote: string): number => {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
      } else if (source[index] === quote) {
        return index + 1;
      } else {
        index += 1;
      }
    }
    return index;
  };

  const skipComment = (start: number): number => {
    if (source[start + 1] === "/") {
      const newline = source.indexOf("\n", start + 2);
      return newline === -1 ? source.length : newline;
    }

    const end = source.indexOf("*/", start + 2);
    return end === -1 ? source.length : end + 2;
  };

  const canStartRegex = (): boolean => {
    return (
      previousText === undefined ||
      new Set([
        "(",
        "[",
        "{",
        "=",
        ":",
        ",",
        ";",
        "!",
        "?",
        "=>",
        "return",
        "case",
        "&&",
        "||",
        "??",
      ]).has(previousText)
    );
  };

  const skipRegex = (start: number): number => {
    let index = start + 1;
    let inClass = false;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "[") {
        inClass = true;
      } else if (character === "]") {
        inClass = false;
      } else if (character === "/" && !inClass) {
        index += 1;
        while (/[A-Za-z]/.test(source[index] ?? "")) {
          index += 1;
        }
        return index;
      } else if (character === "\n" || character === "\r") {
        return start + 1;
      }
      index += 1;
    }
    return index;
  };

  const multiCharacterTokens = [
    "===",
    "!==",
    ">>>=",
    "&&=",
    "||=",
    "??=",
    "**=",
    ">>>",
    "...",
    "=>",
    "==",
    "!=",
    "<=",
    ">=",
    "++",
    "--",
    "&&",
    "||",
    "??",
    "?.",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "**",
    "<<",
    ">>",
    "&=",
    "|=",
    "^=",
  ];

  let scanTemplate: (start: number) => number;
  let scanCode: (start: number, stopAtCloseBrace: boolean) => number;

  const scanTemplateExpression = (start: number): number => scanCode(start, true);

  scanTemplate = (start: number): number => {
    let index = start + 1;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "`") {
        return index + 1;
      }
      if (character === "$" && source[index + 1] === "{") {
        addToken(index + 1, index + 2);
        index = scanTemplateExpression(index + 2);
        continue;
      }
      index += 1;
    }
    return index;
  };

  scanCode = (start: number, stopAtCloseBrace: boolean): number => {
    let index = start;
    let braceDepth = stopAtCloseBrace ? 1 : 0;
    while (index < source.length) {
      const character = source[index];

      if (character === "{") {
        addToken(index, index + 1);
        braceDepth += 1;
        index += 1;
        continue;
      }
      if (character === "}") {
        addToken(index, index + 1);
        if (stopAtCloseBrace) {
          braceDepth -= 1;
          if (braceDepth === 0) {
            return index + 1;
          }
        }
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        const end = skipQuoted(index, character);
        addToken(index, end);
        index = end;
        continue;
      }
      if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
        index = skipComment(index);
        continue;
      }
      if (character === "`") {
        index = scanTemplate(index);
        continue;
      }
      if (character === "/" && canStartRegex()) {
        index = skipRegex(index);
        continue;
      }
      if (/[A-Za-z_$]/.test(character)) {
        let end = index + 1;
        while (/[A-Za-z0-9_$]/.test(source[end] ?? "")) {
          end += 1;
        }
        addToken(index, end);
        index = end;
        continue;
      }
      if (/\s/.test(character)) {
        index += 1;
        continue;
      }

      const multiCharacterToken = multiCharacterTokens.find((token) =>
        source.startsWith(token, index),
      );
      if (multiCharacterToken !== undefined) {
        addToken(index, index + multiCharacterToken.length);
        index += multiCharacterToken.length;
        continue;
      }

      addToken(index, index + 1);
      index += 1;
    }
    return index;
  };

  scanCode(0, false);
  return tokens;
}

function delimitersFor(tokens: Token[]): Delimiters {
  const openToClose: Delimiters = new Map();
  const stack: number[] = [];
  const matchingOpen = new Map<string, string>([
    [")", "("],
    ["]", "["],
    ["}", "{"],
  ]);
  const matchingClose = new Map<string, string>([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (matchingClose.has(token.text)) {
      stack.push(index);
      continue;
    }

    const expectedOpen = matchingOpen.get(token.text);
    if (expectedOpen === undefined) {
      continue;
    }

    const openIndex = stack.at(-1);
    if (openIndex === undefined || tokens[openIndex]?.text !== expectedOpen) {
      continue;
    }

    stack.pop();
    openToClose.set(openIndex, index);
  }

  return openToClose;
}

function expressionText(tokens: Token[], start: number, end: number): string {
  return tokens
    .slice(start, end)
    .map((token) => token.text)
    .join("");
}

function bindingsFor(tokens: Token[]): Bindings {
  const allocationNames = new Set(["mkdtemp", "mkdtempSync"]);
  const allocationNamespaces = new Set<string>();
  const removalNames = new Set(["rm", "rmSync"]);
  const removalNamespaces = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== "import" || tokens[index + 1]?.text === "(") {
      continue;
    }

    const semicolon = tokens.findIndex(
      (token, tokenIndex) => tokenIndex > index && token.text === ";",
    );
    const end = semicolon === -1 ? tokens.length : semicolon;
    let fromIndex = -1;
    for (let tokenIndex = index + 1; tokenIndex < end; tokenIndex += 1) {
      if (tokens[tokenIndex]?.text === "from") {
        fromIndex = tokenIndex;
        break;
      }
    }

    const moduleIndex = fromIndex === -1 ? index + 1 : fromIndex + 1;
    const moduleName = stringLiteralValue(tokens[moduleIndex]?.text);
    if (!MODULES.has(moduleName ?? "")) {
      continue;
    }

    const clauseEnd = fromIndex === -1 ? index + 1 : fromIndex;
    const clause = tokens.slice(index + 1, clauseEnd);
    const braceStart = clause.findIndex((token) => token.text === "{");
    const braceEnd = clause.findIndex(
      (token, tokenIndex) => tokenIndex > braceStart && token.text === "}",
    );

    if (braceStart !== -1 && braceEnd !== -1) {
      let specifierStart = braceStart + 1;
      for (let tokenIndex = braceStart + 1; tokenIndex <= braceEnd; tokenIndex += 1) {
        const isEnd = tokenIndex === braceEnd || clause[tokenIndex]?.text === ",";
        if (!isEnd) {
          continue;
        }

        const specifier = clause.slice(specifierStart, tokenIndex);
        const imported = specifier.find(
          (token) => isIdentifier(token.text) && token.text !== "type",
        )?.text;
        const asIndex = specifier.findIndex((token) => token.text === "as");
        const local = asIndex === -1 ? imported : specifier[asIndex + 1]?.text;

        if (imported === "mkdtemp" || imported === "mkdtempSync") {
          if (isIdentifier(local)) {
            allocationNames.add(local);
          }
        }
        if (imported === "rm" || imported === "rmSync") {
          if (isIdentifier(local)) {
            removalNames.add(local);
          }
        }

        specifierStart = tokenIndex + 1;
      }
    }

    const namespaceStar = clause.findIndex((token) => token.text === "*");
    const namespaceAs =
      namespaceStar === -1
        ? -1
        : clause.findIndex(
            (token, tokenIndex) => tokenIndex > namespaceStar && token.text === "as",
          );
    const namespace = namespaceAs === -1 ? undefined : clause[namespaceAs + 1]?.text;
    if (isIdentifier(namespace)) {
      allocationNamespaces.add(namespace);
      removalNamespaces.add(namespace);
    }

    const defaultImport = clause.find((token, tokenIndex) => {
      if (!isIdentifier(token.text) || token.text === "type") {
        return false;
      }
      const next = clause[tokenIndex + 1]?.text;
      return next === "," || next === "from" || (braceStart === -1 && namespaceStar === -1);
    })?.text;
    if (isIdentifier(defaultImport)) {
      allocationNamespaces.add(defaultImport);
      removalNamespaces.add(defaultImport);
    }
  }

  return { allocationNames, allocationNamespaces, removalNames, removalNamespaces };
}

function callAt(
  tokens: Token[],
  index: number,
  names: Set<string>,
  namespaces: Set<string>,
  expected: string,
): Call | undefined {
  const token = tokens[index];
  if (!token) {
    return undefined;
  }

  if (names.has(token.text) && tokens[index + 1]?.text === "(") {
    return { index, openIndex: index + 1 };
  }

  if (
    namespaces.has(token.text) &&
    tokens[index + 1]?.text === "." &&
    tokens[index + 2]?.text === expected &&
    tokens[index + 3]?.text === "("
  ) {
    return { index, openIndex: index + 3 };
  }

  return undefined;
}

function allocationAt(tokens: Token[], index: number, bindings: Bindings): Call | undefined {
  return (
    callAt(tokens, index, bindings.allocationNames, bindings.allocationNamespaces, "mkdtemp") ??
    callAt(tokens, index, bindings.allocationNames, bindings.allocationNamespaces, "mkdtempSync")
  );
}

function removalAt(tokens: Token[], index: number, bindings: Bindings): Call | undefined {
  return (
    callAt(tokens, index, bindings.removalNames, bindings.removalNamespaces, "rm") ??
    callAt(tokens, index, bindings.removalNames, bindings.removalNamespaces, "rmSync")
  );
}

function statementStart(tokens: Token[], index: number): number {
  for (let tokenIndex = index - 1; tokenIndex >= 0; tokenIndex -= 1) {
    const text = tokens[tokenIndex]?.text;
    if (text === ";" || text === "{" || text === "}") {
      return tokenIndex + 1;
    }
  }
  return 0;
}

function ownerFor(tokens: Token[], index: number): string | undefined {
  const start = statementStart(tokens, index);
  let equalsIndex = -1;
  for (let tokenIndex = index - 1; tokenIndex >= start; tokenIndex -= 1) {
    if (tokens[tokenIndex]?.text === "=") {
      equalsIndex = tokenIndex;
      break;
    }
  }

  if (equalsIndex === -1) {
    return undefined;
  }

  const left = tokens.slice(start, equalsIndex);
  const declarationIndex = left.findLastIndex(
    (token) => token.text === "const" || token.text === "let" || token.text === "var",
  );
  if (declarationIndex !== -1) {
    const declared = left[declarationIndex + 1]?.text;
    return isIdentifier(declared) ? declared : undefined;
  }

  let expressionStart = 0;
  for (let tokenIndex = left.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
    const text = left[tokenIndex]?.text;
    if (text === "(" || text === "[" || text === ",") {
      expressionStart = tokenIndex + 1;
      break;
    }
  }

  const owner = expressionText(left, expressionStart, left.length);
  return owner.length > 0 && !owner.includes("=>") ? owner : undefined;
}

function firstArgument(tokens: Token[], openIndex: number, closeIndex: number): string {
  const nested = new Set(["(", "[", "{"]);
  const closing = new Set([")", "]", "}"]);
  let depth = 0;
  let end = closeIndex;

  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const text = tokens[index]?.text;
    if (nested.has(text ?? "")) {
      depth += 1;
      continue;
    }
    if (closing.has(text ?? "")) {
      depth -= 1;
      continue;
    }
    if (depth === 0 && text === ",") {
      end = index;
      break;
    }
  }

  return expressionText(tokens, openIndex + 1, end);
}

function hasRecursiveOption(tokens: Token[], openIndex: number, closeIndex: number): boolean {
  for (let index = openIndex + 1; index + 2 < closeIndex; index += 1) {
    if (
      tokens[index]?.text === "recursive" &&
      tokens[index + 1]?.text === ":" &&
      tokens[index + 2]?.text === "true"
    ) {
      return true;
    }
  }
  return false;
}

function safeRanges(tokens: Token[], delimiters: Delimiters): Range[] {
  const ranges: Range[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]?.text;
    if (token === "finally" && tokens[index + 1]?.text === "{") {
      const end = delimiters.get(index + 1);
      if (end !== undefined) {
        ranges.push({ end, start: index + 1 });
      }
    }

    if ((token === "afterEach" || token === "afterAll") && tokens[index + 1]?.text === "(") {
      const end = delimiters.get(index + 1);
      if (end !== undefined) {
        ranges.push({ end, start: index + 1 });
      }
    }
  }

  return ranges;
}

function isInRange(index: number, ranges: Range[]): boolean {
  return ranges.some((range) => index > range.start && index < range.end);
}

function cleanupsIn(
  tokens: Token[],
  bindings: Bindings,
  delimiters: Delimiters,
  ranges: Range[],
): Cleanup[] {
  const cleanups: Cleanup[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const call = removalAt(tokens, index, bindings);
    if (!call) {
      continue;
    }

    const closeIndex = delimiters.get(call.openIndex);
    if (closeIndex === undefined) {
      continue;
    }

    cleanups.push({
      ...call,
      argument: firstArgument(tokens, call.openIndex, closeIndex),
      recursive: hasRecursiveOption(tokens, call.openIndex, closeIndex),
    });
  }

  return cleanups.filter((cleanup) => isInRange(cleanup.index, ranges));
}

function registryPushesIn(tokens: Token[], delimiters: Delimiters): RegistryPush[] {
  const pushes: RegistryPush[] = [];

  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if (
      !isIdentifier(tokens[index]?.text) ||
      tokens[index + 1]?.text !== "." ||
      tokens[index + 2]?.text !== "push" ||
      tokens[index + 3]?.text !== "("
    ) {
      continue;
    }

    const closeIndex = delimiters.get(index + 3);
    if (closeIndex === undefined) {
      continue;
    }

    pushes.push({
      argument: firstArgument(tokens, index + 3, closeIndex),
      registry: tokens[index]?.text ?? "",
    });
  }

  return pushes;
}

function forOfsIn(tokens: Token[], delimiters: Delimiters): ForOf[] {
  const loops: ForOf[] = [];

  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index]?.text !== "for" || tokens[index + 1]?.text !== "(") {
      continue;
    }

    const closeIndex = delimiters.get(index + 1);
    if (closeIndex === undefined) {
      continue;
    }

    const ofIndex = tokens.findIndex(
      (token, tokenIndex) =>
        tokenIndex > index + 1 && tokenIndex < closeIndex && token.text === "of",
    );
    const bodyStart = closeIndex + 1;
    if (ofIndex === -1 || tokens[bodyStart]?.text !== "{") {
      continue;
    }

    const bodyEnd = delimiters.get(bodyStart);
    if (bodyEnd === undefined) {
      continue;
    }

    const variable = tokens[ofIndex - 1]?.text;
    if (!isIdentifier(variable)) {
      continue;
    }

    const expression = expressionText(tokens, ofIndex + 1, closeIndex);
    const registry = expression.endsWith(".splice(0)") ? expression.slice(0, -10) : expression;
    if (!isIdentifier(registry)) {
      continue;
    }

    loops.push({ bodyEnd, bodyStart, registry, variable });
  }

  return loops;
}

function allocationsIn(
  tokens: Token[],
  bindings: Bindings,
  file: string,
  source: string,
): Allocation[] {
  const allocations: Allocation[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const call = allocationAt(tokens, index, bindings);
    if (!call) {
      continue;
    }

    const owner = ownerFor(tokens, index);
    allocations.push({
      file,
      line: source.slice(0, tokens[index]?.start ?? 0).split("\n").length,
      owner: owner ?? "<unassigned>",
    });
  }

  return allocations;
}

export function findTempDirCleanupViolations(
  source: string,
  file = "<fixture>.test.ts",
): TempDirCleanupViolation[] {
  const tokens = tokensFor(source);
  const delimiters = delimitersFor(tokens);
  const bindings = bindingsFor(tokens);
  const allocations = allocationsIn(tokens, bindings, file, source);
  const cleanups = cleanupsIn(tokens, bindings, delimiters, safeRanges(tokens, delimiters));
  const registryPushes = registryPushesIn(tokens, delimiters);
  const loops = forOfsIn(tokens, delimiters);
  const usedDirectCleanups = new Set<number>();
  const usedRegistryPushes = new Set<number>();
  const violations: TempDirCleanupViolation[] = [];

  for (const allocation of allocations) {
    if (allocation.owner === "<unassigned>") {
      violations.push({
        ...allocation,
        reason: "temporary directory allocation must be assigned to an owner",
      });
      continue;
    }

    const directCleanupIndex = cleanups.findIndex(
      (cleanup, cleanupIndex) =>
        !usedDirectCleanups.has(cleanupIndex) &&
        cleanup.argument === allocation.owner &&
        cleanup.recursive,
    );
    if (directCleanupIndex !== -1) {
      usedDirectCleanups.add(directCleanupIndex);
      continue;
    }

    const registryCleanup = cleanups.some((cleanup) => {
      if (!cleanup.recursive) {
        return false;
      }

      const loop = loops.find(
        (candidate) =>
          cleanup.index > candidate.bodyStart &&
          cleanup.index < candidate.bodyEnd &&
          cleanup.argument === candidate.variable,
      );
      return (
        loop !== undefined &&
        registryPushes.some((push, pushIndex) => {
          if (usedRegistryPushes.has(pushIndex)) {
            return false;
          }
          const matches = push.registry === loop.registry && push.argument === allocation.owner;
          if (matches) {
            usedRegistryPushes.add(pushIndex);
          }
          return matches;
        })
      );
    });
    if (registryCleanup) {
      continue;
    }

    violations.push({
      ...allocation,
      reason: `no failure-safe recursive cleanup for ${allocation.owner}`,
    });
  }

  return violations;
}

export async function findRepositoryTempDirCleanupViolations(
  repoRoot: string,
): Promise<TempDirCleanupViolation[]> {
  const files = new Set<string>();

  for (const root of TEST_ROOTS) {
    const absoluteRoot = join(repoRoot, root);
    for await (const relativePath of new Bun.Glob("**/*.test.ts").scan({
      cwd: absoluteRoot,
      dot: true,
    })) {
      files.add(join(root, relativePath));
    }
  }

  const violations: TempDirCleanupViolation[] = [];
  for (const file of [...files].sort()) {
    const source = await Bun.file(join(repoRoot, file)).text();
    if (!/\bmkdtemp(?:Sync)?\b/.test(source)) {
      continue;
    }
    violations.push(...findTempDirCleanupViolations(source, file));
  }

  return violations;
}

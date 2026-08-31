// ONE NOUN, ONE DESTINATION: the findings/archive navigation is `/findings`, and `/` is the front
// door.
//
// The front door move made this distinction load-bearing. A navigation label that still points at
// `/` does not 404; it quietly sends a reader to a different page. This guard sweeps the whole
// shipped web source tree, reads each navigational control's own label and destination, and checks
// the data-driven nav entries alongside JSX links. It deliberately does not inspect prose, headings,
// or action buttons such as Search the archive and the Stories close button: those controls do not
// claim to navigate to the archive.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, visitorKeys } from "oxc-parser";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const appRoot = resolve(srcRoot, "..");

const ARCHIVE_NOUN = /\b(?:archive|findings)\b/i;

type AstNode = Record<string, unknown> & {
  end: number;
  start: number;
  type: string;
};

type TextInfo = {
  source: string;
  text: string;
};

type Destination = {
  end: number;
  expression: string | undefined;
  start: number;
  value: string | undefined;
};

type NounControl = {
  destination: Destination;
  file: string;
  label: string;
  line: number;
  source: string;
};

type StaticValues = Map<string, string>;

/** Every `.ts`/`.tsx` source file under `src/`, tests excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }

    return /\.[jt]sx?$/.test(entry) && !/[.](?:test|spec)[.]tsx?$/.test(entry) ? [full] : [];
  });
}

/** Admin has a separate private shell; this guard covers the shipped public navigation tree. */
function isPublicSource(file: string): boolean {
  const name = relative(srcRoot, file).replaceAll("\\", "/");

  return !name.startsWith("routes/admin/") && !name.startsWith("components/admin/");
}

function asNode(value: unknown): AstNode | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.type !== "string" ||
    typeof record.start !== "number" ||
    typeof record.end !== "number"
  ) {
    return undefined;
  }

  return record as AstNode;
}

function childNode(node: AstNode | undefined, key: string): AstNode | undefined {
  return asNode(node?.[key]);
}

function childNodes(node: AstNode | undefined, key: string): AstNode[] {
  const value = node?.[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(asNode).filter((child): child is AstNode => child !== undefined);
}

function walk(node: AstNode, callback: (node: AstNode) => void): void {
  callback(node);

  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key];

    if (Array.isArray(value)) {
      for (const child of value) {
        const childNodeValue = asNode(child);

        if (childNodeValue) {
          walk(childNodeValue, callback);
        }
      }
    } else {
      const childNodeValue = asNode(value);

      if (childNodeValue) {
        walk(childNodeValue, callback);
      }
    }
  }
}

function unwrap(node: AstNode | undefined): AstNode | undefined {
  let current = node;

  while (
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSTypeAssertion"
  ) {
    current = childNode(current, "expression");
  }

  return current;
}

function propertyName(node: AstNode | undefined, source: string): string | undefined {
  const key = childNode(node, "key") ?? childNode(node, "name");

  if (key?.type === "Identifier" || key?.type === "JSXIdentifier") {
    return typeof key.name === "string" ? key.name : undefined;
  }

  if (key?.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }

  return key ? source.slice(key.start, key.end) : undefined;
}

function staticString(
  node: AstNode | undefined,
  source: string,
  values: StaticValues,
): string | undefined {
  const current = unwrap(node);

  if (!current) {
    return undefined;
  }

  if (current.type === "Literal" && typeof current.value === "string") {
    return current.value;
  }

  if (current.type === "Identifier" && typeof current.name === "string") {
    return values.get(current.name);
  }

  if (current.type === "MemberExpression" && current.computed === false) {
    const object = childNode(current, "object");
    const property = childNode(current, "property");

    if (object?.type === "Identifier" && property?.type === "Identifier") {
      const objectName = object.name;
      const propertyNameValue = property.name;

      if (typeof objectName === "string" && typeof propertyNameValue === "string") {
        return values.get(`${objectName}.${propertyNameValue}`);
      }
    }
  }

  if (current.type === "BinaryExpression" && current.operator === "+") {
    const left = staticString(childNode(current, "left"), source, values);
    const right = staticString(childNode(current, "right"), source, values);

    return left !== undefined && right !== undefined ? left + right : undefined;
  }

  if (current.type === "TemplateLiteral") {
    const expressions = childNodes(current, "expressions");

    if (expressions.length > 0) {
      return undefined;
    }

    return childNodes(current, "quasis")
      .map((quasi) => source.slice(quasi.start, quasi.end).replace(/^`|`$/g, ""))
      .join("");
  }

  return undefined;
}

/** Collect the small static label constants used by public controls, including `COPY.browse`. */
function collectStaticValues(root: AstNode, source: string): StaticValues {
  const values: StaticValues = new Map();

  walk(root, (node) => {
    if (node.type !== "VariableDeclarator") {
      return;
    }

    const id = childNode(node, "id");
    const init = unwrap(childNode(node, "init"));

    if (id?.type !== "Identifier" || typeof id.name !== "string" || !init) {
      return;
    }

    const value = staticString(init, source, values);

    if (value !== undefined) {
      values.set(id.name, value);
    }

    if (init.type !== "ObjectExpression") {
      return;
    }

    for (const property of childNodes(init, "properties")) {
      if (property.type !== "Property") {
        continue;
      }

      const name = propertyName(property, source);
      const propertyValue = staticString(childNode(property, "value"), source, values);

      if (name && propertyValue !== undefined) {
        values.set(`${id.name}.${name}`, propertyValue);
      }
    }
  });

  return values;
}

function attribute(opening: AstNode, name: string): AstNode | undefined {
  return childNodes(opening, "attributes").find(
    (candidate) => propertyName(candidate, "") === name,
  );
}

function attributeValue(
  attr: AstNode | undefined,
  source: string,
  values: StaticValues,
): { node: AstNode | undefined; text: string | undefined } {
  const value = childNode(attr, "value");

  if (!value) {
    return { node: undefined, text: undefined };
  }

  const expression =
    value.type === "JSXExpressionContainer" ? childNode(value, "expression") : value;

  return { node: expression, text: staticString(expression, source, values) };
}

function tagName(opening: AstNode | undefined): string | undefined {
  const name = childNode(opening, "name");

  return name?.type === "JSXIdentifier" && typeof name.name === "string" ? name.name : undefined;
}

function textOf(node: AstNode, source: string, values: StaticValues): TextInfo {
  if (node.type === "JSXText") {
    return {
      source: source.slice(node.start, node.end),
      text: typeof node.value === "string" ? node.value : "",
    };
  }

  if (node.type === "JSXExpressionContainer") {
    const expression = childNode(node, "expression");
    const text = staticString(expression, source, values);

    return {
      source: expression ? source.slice(expression.start, expression.end) : "",
      text: text ?? "",
    };
  }

  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    return childNodes(node, "children")
      .map((child) => textOf(child, source, values))
      .reduce(
        (all, child) => ({ source: all.source + child.source, text: all.text + child.text }),
        { source: "", text: "" },
      );
  }

  return { source: "", text: "" };
}

function labelOf(element: AstNode, source: string, values: StaticValues): TextInfo {
  const opening = childNode(element, "openingElement") ?? element;
  const ariaLabel = attributeValue(attribute(opening, "aria-label"), source, values);

  if (ariaLabel.node) {
    return {
      source: source.slice(ariaLabel.node.start, ariaLabel.node.end),
      text: ariaLabel.text ?? "",
    };
  }

  return textOf(element, source, values);
}

function destinationOf(opening: AstNode, source: string, values: StaticValues): Destination {
  const destinationAttribute = attribute(opening, "to") ?? attribute(opening, "href");
  const value = attributeValue(destinationAttribute, source, values);

  return {
    end: value.node?.end ?? destinationAttribute?.end ?? opening.end,
    expression: value.node ? source.slice(value.node.start, value.node.end) : undefined,
    start: value.node?.start ?? destinationAttribute?.start ?? opening.start,
    value: value.text,
  };
}

function renderedDestination(
  opening: AstNode,
  source: string,
  values: StaticValues,
): Destination | undefined {
  const render = attributeValue(attribute(opening, "render"), source, values).node;
  const rendered = unwrap(render);

  if (rendered?.type !== "JSXElement") {
    return undefined;
  }

  const renderedOpening = childNode(rendered, "openingElement");

  return tagName(renderedOpening) === "Link" || tagName(renderedOpening) === "a"
    ? destinationOf(renderedOpening ?? rendered, source, values)
    : undefined;
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function addIfNoun(
  controls: NounControl[],
  file: string,
  source: string,
  label: TextInfo,
  destination: Destination,
  start: number,
): void {
  if (!ARCHIVE_NOUN.test(`${label.text} ${label.source}`)) {
    return;
  }

  const labelText = label.text.replace(/\s+/g, " ").trim();

  controls.push({
    destination,
    file,
    label: labelText || label.source,
    line: lineNumber(source, start),
    source,
  });
}

function scanSource(file: string, source: string): NounControl[] {
  const parsed = parseSync(file, source);

  if (parsed.errors.length > 0) {
    throw new Error(
      `Could not parse ${file}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const root = asNode(parsed.program);

  if (!root) {
    throw new Error(`Could not read the parsed program for ${file}`);
  }

  const values = collectStaticValues(root, source);
  const controls: NounControl[] = [];

  walk(root, (node) => {
    if (node.type === "JSXElement") {
      const opening = childNode(node, "openingElement");
      const tag = tagName(opening);

      if (tag === "Link" || tag === "a") {
        addIfNoun(
          controls,
          file,
          source,
          labelOf(node, source, values),
          destinationOf(opening ?? node, source, values),
          node.start,
        );
      }

      if (tag === "Button") {
        const destination = renderedDestination(opening ?? node, source, values);

        if (destination) {
          addIfNoun(controls, file, source, labelOf(node, source, values), destination, node.start);
        }
      }
    }

    if (node.type !== "ObjectExpression") {
      return;
    }

    const properties = childNodes(node, "properties");
    const labelProperty = properties.find((property) => {
      const name = propertyName(property, source);

      return name === "label" || name === "text";
    });
    const destinationProperty = properties.find((property) => {
      const name = propertyName(property, source);

      return name === "to" || name === "url";
    });

    if (!labelProperty || !destinationProperty) {
      return;
    }

    const labelValue = childNode(labelProperty, "value");

    if (!labelValue) {
      return;
    }

    const label = {
      source: source.slice(labelValue.start, labelValue.end),
      text: staticString(labelValue, source, values) ?? "",
    };
    const destinationValue = childNode(destinationProperty, "value");
    const destination: Destination = {
      end: destinationValue?.end ?? destinationProperty.end,
      expression: destinationValue
        ? source.slice(destinationValue.start, destinationValue.end)
        : undefined,
      start: destinationValue?.start ?? destinationProperty.start,
      value: staticString(destinationValue, source, values),
    };

    addIfNoun(controls, file, source, label, destination, node.start);
  });

  return controls;
}

function allNounControls(): NounControl[] {
  return sourceFiles(srcRoot)
    .filter(isPublicSource)
    .flatMap((file) => scanSource(file, readFileSync(file, "utf8")));
}

function destinationViolation(control: NounControl): string | undefined {
  if (control.destination.value === undefined) {
    return `${relative(srcRoot, control.file)}:${control.line} ${control.label} has a non-literal or missing destination (${control.destination.expression ?? "none"})`;
  }

  if (control.destination.value !== "/findings") {
    return `${relative(srcRoot, control.file)}:${control.line} ${control.label} points to ${control.destination.value}`;
  }

  return undefined;
}

function replaceDestination(control: NounControl, replacement: string): string {
  return (
    control.source.slice(0, control.destination.start) +
    replacement +
    control.source.slice(control.destination.end)
  );
}

describe("every public findings/archive navigation control goes to the archive", () => {
  it("sweeps the shipped source tree and finds the current control inventory", () => {
    const controls = allNounControls();
    const names = controls.map((control) => `${relative(srcRoot, control.file)}:${control.label}`);

    expect(controls.length).toBeGreaterThanOrEqual(22);
    expect(names).toContain("lib/docs-layout.shared.tsx:Findings");
    expect(names).toContain("routes/device.tsx:Back to findings");
    expect(names).toContain("routes/mix.tsx:See the findings");
    // 18 with `/search`, the persistent search surface, whose plate footer carries the same way
    // home every other plate does.
    expect(names.filter((name) => name.endsWith(":Back to the archive"))).toHaveLength(18);
  });

  it("uses each control's own destination, rejecting wrong and unresolved expressions", () => {
    const violations = allNounControls().map(destinationViolation).filter(Boolean);

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("proves reverting every current control makes this guard fail", () => {
    for (const control of allNounControls()) {
      const reverted = replaceDestination(control, '"/"');
      const violations = scanSource(control.file, reverted)
        .map(destinationViolation)
        .filter(Boolean);

      expect(
        violations.some((violation) => violation?.includes("points to /")),
        `${relative(srcRoot, control.file)}:${control.line} ${control.label} was not mutation-sensitive`,
      ).toBe(true);
    }
  });

  it("proves a non-literal destination fails instead of passing silently", () => {
    const source = `import { Link } from "@tanstack/react-router";\nexport function Control() { return <Link to={destination}>Back to the archive</Link>; }`;
    const [control] = scanSource("archive-destination-mutation.tsx", source);
    const violation = control ? destinationViolation(control) : undefined;

    expect(violation).toContain("non-literal or missing destination");
  });
});

describe("the two agent-facing documents name the same pages", () => {
  const llms = readFileSync(join(appRoot, "public", "llms.txt"), "utf8");
  const markdownHome = readFileSync(join(srcRoot, "lib", "server", "agent-discovery.ts"), "utf8");

  /** The URL a markdown link list gives a named entry, with `${siteUrl}` folded to the real host. */
  function linkTarget(document: string, label: string): string | undefined {
    const match = new RegExp(`\\[${label}\\]\\(([^)]+)\\)`).exec(document);

    return match?.[1]?.replace("${siteUrl}", "https://www.fluncle.com");
  }

  it("both call https://www.fluncle.com/findings the archive", () => {
    expect(linkTarget(llms, "The archive")).toBe("https://www.fluncle.com/findings");
    expect(linkTarget(markdownHome, "The archive")).toBe("https://www.fluncle.com/findings");
  });

  it("both call the bare root the front door", () => {
    expect(linkTarget(llms, "The front door")).toBe("https://www.fluncle.com/");
    expect(linkTarget(markdownHome, "The front door")).toBe("https://www.fluncle.com/");
  });

  it("neither document still points the archive at the root", () => {
    for (const [name, document] of [
      ["llms.txt", llms],
      ["the generated markdown homepage", markdownHome],
    ] as const) {
      expect(
        document.includes("[The archive](https://www.fluncle.com/)") ||
          document.includes("[The archive](${siteUrl}/)"),
        `${name} still calls the front door the archive`,
      ).toBe(false);
    }
  });
});

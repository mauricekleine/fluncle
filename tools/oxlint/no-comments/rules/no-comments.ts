import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type Comment = ESTree.Comment;

function isDirective(comment: Comment): boolean {
  if (comment.type === "Shebang") {
    return true;
  }
  const value = comment.value.trim();
  return (
    /^(?:oxlint|eslint)-disable(?:\b|-)/u.test(value) ||
    /^@ts-expect-error\b/u.test(value) ||
    /^@vitest-environment\s/u.test(value) ||
    /^@vite-ignore\b/u.test(value)
  );
}

function jsxExpressionContainer(
  sourceCode: SourceCode,
  comment: Comment,
): ESTree.JSXExpressionContainer | undefined {
  let node = sourceCode.getNodeByRangeIndex(comment.start);
  while (node && node.type !== "Program") {
    if (node.type === "JSXExpressionContainer") {
      const containerText = sourceCode.text.slice(node.start + 1, node.end - 1).trim();
      const commentText = sourceCode.text.slice(comment.start, comment.end).trim();
      if (containerText === commentText) {
        return node;
      }
    }
    node = node.parent;
  }
  return undefined;
}

function removalRange(sourceCode: SourceCode, comment: Comment): readonly [number, number] {
  const container = jsxExpressionContainer(sourceCode, comment);
  if (container) {
    return [container.start, container.end];
  }

  const { text } = sourceCode;
  const lineStart = text.lastIndexOf("\n", comment.start - 1) + 1;
  const newline = text.indexOf("\n", comment.end);
  const lineEnd = newline === -1 ? text.length : newline;
  const before = text.slice(lineStart, comment.start);
  const after = text.slice(comment.end, lineEnd);

  if (before.trim() === "" && after.trim() === "") {
    return [lineStart, lineEnd];
  }

  if (before.trim() !== "") {
    const precedingWhitespace = before.length - before.trimEnd().length;
    return [comment.start - precedingWhitespace, comment.end];
  }

  const followingWhitespace = after.length - after.trimStart().length;
  return [comment.start, comment.end + followingWhitespace];
}

export const noCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow comments except directives consumed by tools.",
    },
    fixable: "whitespace",
    messages: {
      forbidden: "Remove this comment. Put durable context in code, tests, errors, or an ADR.",
    },
  },
  createOnce(context) {
    return {
      "Program:exit"() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (isDirective(comment)) {
            continue;
          }
          context.report({
            loc: comment.loc,
            messageId: "forbidden",
            fix(fixer) {
              return fixer.removeRange(removalRange(context.sourceCode, comment));
            },
          });
        }
      },
    };
  },
});

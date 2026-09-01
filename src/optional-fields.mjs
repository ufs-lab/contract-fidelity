// contract-fidelity: which contract fields cost the most defensive code.
//
// The two scanners report code that is provably wrong. This command reports
// code that is provably LEGAL and probably unnecessary, which is a different
// and larger problem.
//
// A guard on a field the contract declares optional cannot be called dead. If
// the schema says the field may be absent, the check is correct, and no
// analysis of the consuming code can say otherwise. But most such fields are
// optional only because nobody wrote `required` in the OpenAPI document. The
// service returns them every time. The optionality is an accident, and every
// `??` built on it is real code, written and reviewed and maintained, that
// exists to handle a case that never happens.
//
// That is not a lint. It is a work queue for the service repositories, and it
// belongs in whoever owns the schema's backlog rather than in a gate. This
// command measures it: for each optional contract field, how much defensive
// code the consuming codebase carries because of it, ranked by payoff.
//
// The moment a field is marked required upstream and the client regenerates,
// every guard counted here becomes a `dead-code` finding, and that scanner
// deletes them.

import ts from "typescript";
import { relative } from "node:path";

import {
  createProgram,
  contractPathRe,
  REPO_ROOT,
  isScannedFile,
} from "./program.mjs";
import { isClientDeclaration } from "./contract.mjs";
import { lineOf } from "./analyze.mjs";

// The shapes that exist to handle an absent value. Counted per field, because
// the count is the argument for changing the schema.
const GUARD = {
  NULLISH_COALESCE: "??",
  OPTIONAL_CHAIN: "?.",
  EQUALITY: "=== / !== null | undefined",
  FALSY: "!x",
  TERNARY: "x ? a : b",
};

function isOptionalOrNullable(symbol, checker, atNode) {
  if ((symbol.flags & ts.SymbolFlags.Optional) !== 0) return true;
  const type = checker.getTypeOfSymbolAtLocation(symbol, atNode);
  const parts = type.isUnion() ? type.types : [type];
  return parts.some(
    (part) =>
      (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0,
  );
}

// Which defensive shape, if any, is this property read sitting inside?
//
// Only the shapes that BRANCH on absence count. A plain read is not defensive
// code, and counting it would make every field look expensive.
function guardShapeAround(read) {
  const parent = read.parent;
  if (!parent) return null;

  if (
    ts.isPropertyAccessExpression(read) &&
    read.questionDotToken !== undefined
  ) {
    return GUARD.OPTIONAL_CHAIN;
  }
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === read &&
    parent.questionDotToken !== undefined
  ) {
    return GUARD.OPTIONAL_CHAIN;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    parent.left === read
  ) {
    return GUARD.NULLISH_COALESCE;
  }
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    const comparison =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (comparison) {
      const other = parent.left === read ? parent.right : parent.left;
      const kind = other.kind;
      if (
        kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(other) && other.text === "undefined")
      ) {
        return GUARD.EQUALITY;
      }
    }
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return GUARD.FALSY;
    }
  }
  if (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return GUARD.FALSY;
  }
  if (ts.isConditionalExpression(parent) && parent.condition === read) {
    return GUARD.TERNARY;
  }
  if (ts.isIfStatement(parent) && parent.expression === read) {
    return GUARD.FALSY;
  }
  return null;
}

export function collectOptionalFieldCost() {
  const program = createProgram();
  const checker = program.getTypeChecker();

  // field key -> { field, owner, guards: Map<shape, count>, sites: [] }
  const byField = new Map();

  for (const sf of program.getSourceFiles()) {
    if (!isScannedFile(sf)) continue;

    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        const decl = symbol?.declarations?.[0];
        if (
          symbol &&
          decl &&
          contractPathRe().test(decl.getSourceFile().fileName) &&
          isClientDeclaration(decl) &&
          isOptionalOrNullable(symbol, checker, node.name)
        ) {
          const shape = guardShapeAround(node);
          if (shape) {
            const owner = decl.parent;
            const ownerName =
              owner &&
              (ts.isInterfaceDeclaration(owner) ||
                ts.isClassDeclaration(owner)) &&
              owner.name
                ? owner.name.text
                : "(anonymous)";
            const key = `${ownerName}.${symbol.getName()}`;
            if (!byField.has(key)) {
              byField.set(key, {
                field: key,
                guards: new Map(),
                sites: [],
              });
            }
            const row = byField.get(key);
            row.guards.set(shape, (row.guards.get(shape) ?? 0) + 1);
            row.sites.push({
              file: relative(REPO_ROOT, sf.fileName),
              line: lineOf(node),
              shape,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return [...byField.values()].sort(
    (a, b) => b.sites.length - a.sites.length || a.field.localeCompare(b.field),
  );
}

export function main(argv) {
  const rows = collectOptionalFieldCost();
  const total = rows.reduce((n, r) => n + r.sites.length, 0);

  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        rows.map((r) => ({
          field: r.field,
          guards: r.sites.length,
          byShape: Object.fromEntries(r.guards),
          sites: r.sites,
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (rows.length === 0) {
    process.stdout.write(
      "optional-fields: no defensive code on optional contract fields\n",
    );
    return 0;
  }

  process.stdout.write(
    `${total} guard(s) on ${rows.length} optional contract field(s), ` +
      "ranked by how much code each one costs.\n\n" +
      "Each of these is LEGAL: the schema says the field may be absent, so\n" +
      "the guard is correct and no scanner can delete it. Mark the field\n" +
      "required upstream, regenerate the client, and `contract-fidelity\n" +
      "dead-code` will find every one of them.\n\n",
  );

  const width = Math.max(...rows.map((r) => r.field.length));
  for (const row of rows) {
    const shapes = [...row.guards.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([shape, n]) => `${shape} x${n}`)
      .join(", ");
    process.stdout.write(
      `  ${String(row.sites.length).padStart(4)}  ${row.field.padEnd(width)}  ${shapes}\n`,
    );
    if (argv.includes("--list")) {
      for (const site of row.sites.slice(0, 5)) {
        process.stdout.write(`        ${site.file}:${site.line}\n`);
      }
      if (row.sites.length > 5) {
        process.stdout.write(`        ... ${row.sites.length - 5} more\n`);
      }
    }
  }
  return 0;
}

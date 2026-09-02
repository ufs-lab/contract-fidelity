// contract-fidelity: origin -> widening -> dead guard.
//
// A finding is a PAIR, never a lone widening: the contract guarantee that
// entered from a generated client, the signature that dropped it, and the
// defensive check downstream that the guarantee already decides. Widening on
// its own is `tools/type-widening`'s job; a redundant check TypeScript can
// see for itself is `@typescript-eslint/no-unnecessary-condition`'s. This
// tool owns only the gap between them.

import ts from "typescript";
import { onlyNullishWasAdded } from "./inferred.mjs";
import {
  decideNumericComparison,
  flipOperator,
  interval,
} from "./constraints.mjs";
import { constraintForClientProperty, contractPathFor } from "./contract.mjs";

const COMPARISON_OPS = new Map([
  [ts.SyntaxKind.GreaterThanToken, ">"],
  [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
  [ts.SyntaxKind.LessThanToken, "<"],
  [ts.SyntaxKind.LessThanEqualsToken, "<="],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "==="],
  [ts.SyntaxKind.EqualsEqualsToken, "=="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!=="],
  [ts.SyntaxKind.ExclamationEqualsToken, "!="],
]);

// A numeric literal, including a negated one (`x < -1`).
function numericLiteralValue(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return null;
}

function lineOf(node) {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function textOf(node, max = 80) {
  const t = node.getText().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

// Given a reference to a tracked value, decide whether its surrounding
// expression is a check the contract already answers. Returns a finding
// fragment or null.
function classifyGuard(ref, constraint, checker) {
  const parent = ref.parent;
  if (!parent) return null;

  const runtimeTest = classifyRuntimeTypeGuard(ref, parent, constraint);
  if (runtimeTest) return runtimeTest;

  if (constraint.kind === "enum-member") {
    return classifyEnumGuard(ref, parent, constraint);
  }
  if (constraint.kind === "required-non-null") {
    return classifyNullishGuard(ref, parent, constraint);
  }
  if (constraint.kind === "non-empty-array") {
    return classifyLengthGuard(ref, parent, constraint);
  }
  return classifyNumericGuard(ref, parent, constraint, checker);
}

function classifyNumericGuard(ref, parent, constraint, checker) {
  // `amount > 0`, `0 < amount`
  if (ts.isBinaryExpression(parent)) {
    const op = COMPARISON_OPS.get(parent.operatorToken.kind);
    if (!op) return null;
    const refIsLeft = parent.left === ref;
    const other = refIsLeft ? parent.right : parent.left;
    const k = numericLiteralValue(other);
    if (k === null) return null;
    const effectiveOp = refIsLeft ? op : flipOperator(op);
    const verdict = decideNumericComparison(
      constraint.interval,
      effectiveOp,
      k,
    );
    if (verdict === "undecided") return null;
    return {
      verdict,
      guard: textOf(parent),
      guardNode: parent,
      shape: "comparison",
    };
  }

  // `Math.max(0, amount)` / `Math.abs(amount)` on a value already known
  // non-negative: a clamp that can never clamp.
  const clamp = classifyMathClamp(ref, parent, constraint);
  if (clamp) return clamp;

  return null;
}

function classifyMathClamp(ref, parent, constraint) {
  if (!ts.isCallExpression(parent)) return null;
  const callee = parent.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "Math")
    return null;
  const fn = callee.name.text;
  const loNonNegative = constraint.interval.lo >= 0;
  if (!loNonNegative) return null;

  if (
    fn === "abs" &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === ref
  ) {
    return {
      verdict: "always-true",
      guard: textOf(parent),
      guardNode: parent,
      shape: "no-op-abs",
    };
  }
  if (fn === "max" && parent.arguments.length === 2) {
    const [a, b] = parent.arguments;
    const floor =
      a === ref
        ? numericLiteralValue(b)
        : b === ref
          ? numericLiteralValue(a)
          : null;
    // `Math.max(0, x)` where x >= 0 always returns x.
    if (
      floor !== null &&
      decideNumericComparison(constraint.interval, ">=", floor) ===
        "always-true"
    ) {
      return {
        verdict: "always-true",
        guard: textOf(parent),
        guardNode: parent,
        shape: "no-op-clamp",
      };
    }
  }
  return null;
}

function classifyLengthGuard(ref, parent, constraint) {
  // Only `.length` reads carry the non-empty guarantee.
  if (!ts.isPropertyAccessExpression(parent) || parent.name.text !== "length")
    return null;
  const lengthExpr = parent;
  const grand = lengthExpr.parent;

  if (grand && ts.isBinaryExpression(grand)) {
    const op = COMPARISON_OPS.get(grand.operatorToken.kind);
    if (!op) return null;
    const refIsLeft = grand.left === lengthExpr;
    const other = refIsLeft ? grand.right : grand.left;
    const k = numericLiteralValue(other);
    if (k === null) return null;
    const effectiveOp = refIsLeft ? op : flipOperator(op);
    const verdict = decideNumericComparison(
      constraint.interval,
      effectiveOp,
      k,
    );
    if (verdict === "undecided") return null;
    return {
      verdict,
      guard: textOf(grand),
      guardNode: grand,
      shape: "length-comparison",
    };
  }

  // `if (!rows.length)` - a zero-length test spelled as a falsy test.
  if (
    grand &&
    ts.isPrefixUnaryExpression(grand) &&
    grand.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return {
      verdict: "always-false",
      guard: textOf(grand),
      guardNode: grand,
      shape: "length-falsy",
    };
  }
  return null;
}

// `typeof x === "string"` and `Array.isArray(x)` against a value whose kind
// the contract already fixes. These are the shapes that appear once a value
// has been widened to `unknown` and the code starts re-establishing at
// runtime what the contract already promised.
function classifyRuntimeTypeGuard(ref, parent, constraint) {
  if (!constraint.baseKind) return null;
  // `typeof` reports "object" for arrays.
  const expected =
    constraint.baseKind === "array" ? "object" : constraint.baseKind;

  if (ts.isTypeOfExpression(parent) && parent.expression === ref) {
    const cmp = parent.parent;
    if (!cmp || !ts.isBinaryExpression(cmp)) return null;
    const op = COMPARISON_OPS.get(cmp.operatorToken.kind);
    if (!op || !["===", "==", "!==", "!="].includes(op)) return null;
    const other = cmp.left === parent ? cmp.right : cmp.left;
    if (!ts.isStringLiteralLike(other)) return null;
    const matches = other.text === expected;
    const negated = op === "!==" || op === "!=";
    return {
      verdict: matches !== negated ? "always-true" : "always-false",
      guard: textOf(cmp),
      guardNode: cmp,
      shape: "typeof-test",
    };
  }

  if (
    ts.isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === ref &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ts.isIdentifier(parent.expression.expression) &&
    parent.expression.expression.text === "Array" &&
    parent.expression.name.text === "isArray"
  ) {
    // Only decidable when the contract fixes the kind either way.
    if (constraint.baseKind === "object") return null;
    return {
      verdict: constraint.baseKind === "array" ? "always-true" : "always-false",
      guard: textOf(parent),
      guardNode: parent,
      shape: "is-array-test",
    };
  }

  return null;
}

function classifyNullishGuard(ref, parent, constraint) {
  // `x ?? fallback` - only when the tracked value is the LEFT side.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    parent.left === ref
  ) {
    return {
      verdict: "always-true",
      guard: textOf(parent),
      guardNode: parent,
      shape: "nullish-fallback",
    };
  }

  // `x === null`, `x !== undefined`, `x == null`
  if (ts.isBinaryExpression(parent)) {
    const op = COMPARISON_OPS.get(parent.operatorToken.kind);
    if (op) {
      const other = parent.left === ref ? parent.right : parent.left;
      const isNullish =
        other.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(other) && other.text === "undefined");
      if (isNullish) {
        const negated = op === "!==" || op === "!=";
        return {
          verdict: negated ? "always-true" : "always-false",
          guard: textOf(parent),
          guardNode: parent,
          shape: "nullish-comparison",
        };
      }
    }
  }

  // `x?.foo` - optional chaining on a value that is never nullish.
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isCallExpression(parent)) &&
    parent.questionDotToken &&
    parent.expression === ref
  ) {
    return {
      verdict: "always-true",
      guard: textOf(parent),
      guardNode: parent,
      shape: "optional-chain",
    };
  }

  // `!x` is a falsy test, not a nullish one: "" and 0 are falsy but legal
  // for a required non-null string or number. Only object-like values make
  // it decidable.
  if (
    constraint.isObjectLike &&
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return {
      verdict: "always-false",
      guard: textOf(parent),
      guardNode: parent,
      shape: "falsy-object",
    };
  }

  return null;
}

function classifyEnumGuard(ref, parent, constraint) {
  // `scope === "NOT_A_MEMBER"` can never hold.
  if (ts.isBinaryExpression(parent)) {
    const op = COMPARISON_OPS.get(parent.operatorToken.kind);
    if (!op || (op !== "===" && op !== "!==" && op !== "==" && op !== "!="))
      return null;
    const other = parent.left === ref ? parent.right : parent.left;
    if (!ts.isStringLiteralLike(other)) return null;
    const isMember = constraint.members.includes(other.text);
    if (isMember) return null;
    const negated = op === "!==" || op === "!=";
    return {
      verdict: negated ? "always-true" : "always-false",
      guard: textOf(parent),
      guardNode: parent,
      shape: "enum-non-member",
    };
  }

  // A `default:` clause in a switch whose cases already name every member.
  if (ts.isSwitchStatement(parent) && parent.expression === ref) {
    const clauses = parent.caseBlock.clauses;
    const covered = new Set();
    let defaultClause = null;
    for (const clause of clauses) {
      if (ts.isDefaultClause(clause)) {
        defaultClause = clause;
        continue;
      }
      if (ts.isStringLiteralLike(clause.expression))
        covered.add(clause.expression.text);
    }
    if (!defaultClause) return null;
    const missing = constraint.members.filter((m) => !covered.has(m));
    if (missing.length > 0) return null;
    return {
      verdict: "always-false",
      guard: "default:",
      guardNode: defaultClause,
      shape: "unreachable-default",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return node.getSourceFile();
}

// Every identifier in `scope` that resolves to `symbol`.
function referencesTo(symbol, scope, checker) {
  const refs = [];
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const s = checker.getSymbolAtLocation(node);
      if (s === symbol) refs.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return refs;
}

// Does this declared type still carry the constraint? A parameter annotated
// with the client's own enum type has NOT widened; one annotated `string`
// has. For doc-stated numeric guarantees the TypeScript type is `number`
// either way, so the guarantee is lost the moment the value leaves the
// property access - that IS the widening this tool is named for.
// A nullable, `unknown`, `any`, or `unknown[]` annotation has dropped what
// the contract promised - the three shapes that make a runtime re-check look
// necessary when it is not.
function dropsGuarantee(type, checker) {
  const parts = type.isUnion() ? type.types : [type];
  if (
    parts.some(
      (p) => (p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0,
    )
  )
    return true;
  if (
    parts.some(
      (p) => (p.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0,
    )
  )
    return true;
  if (checker.isArrayType?.(type)) {
    const [element] = checker.getTypeArguments?.(type) ?? [];
    if (
      element &&
      (element.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0
    )
      return true;
  }
  return false;
}

// A parameter that ASKS for anything is not a guarantee that went missing.
//
//   function isObject(value: unknown): value is Record<string, unknown>
//   function requireStringIdentifier(value: unknown, field: string): string
//
// Widening is the accidental loss of a specific type - `EntityScope` becoming
// `string`, `T` becoming `T | null`. Declaring `unknown` is deliberate: the
// author is taking responsibility for checking, and the checks inside are the
// point of the function, not dead weight. Both shapes below say "validator":
// a type-predicate return type, or a bare `unknown`/`any` parameter on a
// function that throws.
//
// Kept narrow on purpose: `accounts: unknown[] | undefined` is NOT a bare
// `unknown`, and a function that returns a default rather than throwing is
// not asserting anything - those stay in scope.
function isValidatorBoundary(paramDecl, checker) {
  const fn = paramDecl.parent;

  if (fn.type && ts.isTypePredicateNode(fn.type)) return true;

  // `function assertRequired(value: T | undefined): T { if (!value) throw }`
  // is a validator by every meaning of the word, and its parameter type is
  // the whole point of it. Measured against a real codebase this was the
  // worst false positive the parameter carrier produced: 21 call sites, all
  // passing present values, and narrowing the parameter would delete the
  // function's reason to exist. A function that THROWS on the absent case is
  // asserting, whatever it spells its parameter.
  const asserts = fn.type && ts.isTypePredicateNode(fn.type);
  if (asserts) return true;

  if (!paramDecl.type) return false;
  const declared = paramDecl.type.kind;
  const isBareUnknown =
    declared === ts.SyntaxKind.UnknownKeyword ||
    declared === ts.SyntaxKind.AnyKeyword;
  const declaredType = checker.getTypeAtLocation(paramDecl.type);
  const acceptsAbsent = dropsGuarantee(declaredType, checker);
  if (!isBareUnknown && !acceptsAbsent) return false;

  let throws = false;
  const scan = (node) => {
    if (throws) return;
    if (ts.isThrowStatement(node)) {
      throws = true;
      return;
    }
    // Nested functions have their own control flow.
    if (
      node !== fn.body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node))
    )
      return;
    ts.forEachChild(node, scan);
  };
  if (fn.body) scan(fn.body);
  return throws;
}

function widensAwayFrom(paramDecl, constraint, checker) {
  if (isValidatorBoundary(paramDecl, checker)) return false;

  if (constraint.kind === "enum-member") {
    if (!paramDecl.type) return true;
    const t = checker.getTypeAtLocation(paramDecl.type);
    // Still the union? Then nothing was dropped.
    return !(t.isUnion() && t.types.every((p) => p.isStringLiteral()));
  }
  if (constraint.kind === "required-non-null") {
    if (!paramDecl.type) return false;
    const t = checker.getTypeAtLocation(paramDecl.type);
    if (!dropsGuarantee(t, checker)) return false;
    // See typeDropsConstraint: an inferred guarantee only licenses the
    // mechanical case, where nullish is the whole of the difference.
    if (constraint.origin === "inferred") {
      return onlyNullishWasAdded(t, constraint, checker);
    }
    return true;
  }
  // Numeric / non-empty-array guarantees live only in the doc comment.
  return true;
}

export {
  classifyGuard,
  referencesTo,
  enclosingFunction,
  widensAwayFrom,
  dropsGuarantee,
  lineOf,
  textOf,
};

// contract-fidelity: the declaration carriers besides fields.
//
// A field on a view model is not the only place a guarantee gets dropped.
// The same loss happens at a local annotation, a declared return type, or a
// cast - each is a declaration that says less than the value flowing into it:
//
//   const name: string | undefined = account.entity.name;   // local
//   function f(a: AccountResponse): string | undefined {     // return type
//     return a.entity.name;
//   }
//   account.entity.name as string | undefined;               // cast
//
// None of these needs a census: unlike a field, a local, a return position
// and a cast each have exactly one value flowing into them at the site
// itself, so the constraint is decided there and nowhere else.

import ts from "typescript";
import { guaranteeOfExpression } from "./census.mjs";
import { typeDropsConstraint } from "./fields.mjs";
import { widensAwayFrom } from "./analyze.mjs";
import { guaranteeAcrossCallSites } from "./census.mjs";
import { getConfig } from "./program.mjs";

function widened(expr, typeNode, checker) {
  if (!expr || !typeNode) return null;
  const constraint = guaranteeOfExpression(sourceOf(expr), checker);
  if (!constraint) return null;
  const type = checker.getTypeAtLocation(typeNode);
  if (!typeDropsConstraint(type, checker, constraint)) return null;
  return constraint;
}

// `x as unknown as T` is the shape people reach for when the compiler
// objects. The intermediate hop states nothing, so reading the type at the
// outer cast finds `unknown` and the laundering hides behind its own
// mechanism. Look through it to the value that actually flows in.
function sourceOf(expr) {
  let node = expr;
  while (
    (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
    (node.type.kind === ts.SyntaxKind.UnknownKeyword ||
      node.type.kind === ts.SyntaxKind.AnyKeyword)
  ) {
    node = node.expression;
  }
  return node;
}

// A `let` annotated wider than its initialiser may be doing real work: the
// wider type is there for a later assignment. Only a `const` proves the
// declared type is the whole story.
function isConstDeclaration(node) {
  const list = node.parent;
  return (
    list &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

// Every `return` an arrow/function body can produce, without descending into
// nested functions (their returns belong to them).
function returnExpressions(fn) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body]; // concise arrow body
  const out = [];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression)
      out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

export function findWidenedDeclarations(program, checker, isScanned) {
  const found = [];

  for (const sf of program.getSourceFiles()) {
    if (!isScanned(sf)) continue;

    const visit = (node) => {
      // const name: string | undefined = account.entity.name;
      if (
        ts.isVariableDeclaration(node) &&
        node.type &&
        node.initializer &&
        ts.isIdentifier(node.name) &&
        isConstDeclaration(node)
      ) {
        const constraint = widened(node.initializer, node.type, checker);
        if (constraint) {
          found.push({
            node,
            carrier: "local",
            text: `${node.name.text}: ${node.type.getText()}`,
            source: node.initializer,
            constraint,
          });
        }
      }

      // function f(...): string | undefined { return account.entity.name }
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node)) &&
        node.type
      ) {
        const returns = returnExpressions(node);
        // Every return must carry the same guarantee: one that does not means
        // the wider type is doing real work.
        if (returns.length > 0) {
          const constraints = returns.map((r) =>
            widened(r, node.type, checker),
          );
          const kinds = new Set(constraints.map((c) => c?.kind ?? null));
          if (!kinds.has(null) && kinds.size === 1) {
            const name = node.name?.getText() ?? "(anonymous)";
            found.push({
              node: node.type,
              carrier: "return type",
              text: `${name}(): ${node.type.getText()}`,
              source: returns[0],
              constraint: constraints[0],
            });
          }
        }
      }

      // A collection whose ELEMENT type is wider than what goes into it:
      //   const names: (string | null)[] = [account.entity.name];
      //   const byId: Record<string, string | undefined> = { x: a.entity.name };
      // The element type is the declaration here, so it is checked against
      // every element written at the site.
      if (
        ts.isVariableDeclaration(node) &&
        node.type &&
        node.initializer &&
        isConstDeclaration(node) &&
        (ts.isArrayLiteralExpression(node.initializer) ||
          ts.isObjectLiteralExpression(node.initializer))
      ) {
        const declared = checker.getTypeAtLocation(node.type);
        const elementType = ts.isArrayLiteralExpression(node.initializer)
          ? (checker.getTypeArguments?.(declared) ?? [])[0]
          : checker.getIndexTypeOfType?.(declared, ts.IndexKind.String);
        const elements = ts.isArrayLiteralExpression(node.initializer)
          ? node.initializer.elements
          : node.initializer.properties
              .filter(ts.isPropertyAssignment)
              .map((prop) => prop.initializer);
        if (elementType && elements.length > 0) {
          const constraints = elements.map((el) =>
            guaranteeOfExpression(sourceOf(el), checker),
          );
          const kinds = new Set(constraints.map((c) => c?.kind ?? null));
          if (
            !kinds.has(null) &&
            kinds.size === 1 &&
            typeDropsConstraint(elementType, checker, constraints[0])
          ) {
            found.push({
              node,
              carrier: "collection element",
              text: `${node.name.getText()}: ${node.type.getText()}`,
              source: elements[0],
              constraint: constraints[0],
            });
          }
        }
      }

      // account.entity.name as string | undefined
      //
      // `x as unknown as T` is two AsExpressions. The inner hop is reported
      // through the outer one, so reporting it again would bill one edit
      // twice and put two fingerprints in the baseline for one line.
      const isIntermediateHop =
        ts.isAsExpression(node) &&
        node.parent &&
        ts.isAsExpression(node.parent) &&
        (node.type.kind === ts.SyntaxKind.UnknownKeyword ||
          node.type.kind === ts.SyntaxKind.AnyKeyword);
      if (ts.isAsExpression(node) && !isIntermediateHop) {
        const constraint = widened(node.expression, node.type, checker);
        if (constraint) {
          found.push({
            node,
            carrier: "cast",
            text: node.getText().replace(/\s+/g, " ").slice(0, 60),
            // The value that really flows in, not the `as unknown` hop.
            source: sourceOf(node.expression),
            constraint,
          });
        }
      }

      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return found;
}

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
]);

// Is this function reachable from outside the program we can see?
//
// Under `closedWorld` the callers in this program are all the callers there
// are, so an export with a unanimous census is proven like any other
// function. A library cannot assume that: its exports are called by code
// this program will never index, and an empty or partial census there proves
// nothing at all.
function isExported(fn) {
  for (let node = fn; node; node = node.parent) {
    const modifiers = ts.canHaveModifiers?.(node)
      ? ts.getModifiers(node)
      : node.modifiers;
    if (
      modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
      (ts.isExportAssignment(node) ?? false)
    ) {
      return true;
    }
    if (ts.isSourceFile(node)) return false;
  }
  return false;
}

// A parameter declared wider than every value its callers hand it.
//
// The guard analysis reports a parameter only once somebody has written the
// dead check on it. The widening is falsifiable before that, against the
// census alone, and reporting it then is what stops the check being written.
export function findWidenedParameters(program, checker, census, isScanned) {
  const closedWorld = getConfig().closedWorld;
  const found = [];

  for (const sf of program.getSourceFiles()) {
    if (!isScanned(sf)) continue;

    const visit = (node) => {
      if (FUNCTION_LIKE.has(node.kind) && node.parameters) {
        if (closedWorld || !isExported(node)) {
          for (const param of node.parameters) {
            // No annotation means nothing was widened: the inferred type is
            // whatever was passed.
            if (!param.type || !ts.isIdentifier(param.name)) continue;
            const proven = guaranteeAcrossCallSites(param, census, checker);
            if (!proven) continue;
            const { constraint, example, callSites } = proven;
            // A doc-stated guarantee - `must be > 0`, `1-31`, `non-empty` -
            // has no narrower TypeScript type to move to, so a finding here
            // would demand an edit that does not exist. `dead-code` still
            // enforces those, where a dead guard proves the loss did harm.
            if (
              constraint.kind !== "required-non-null" &&
              constraint.kind !== "enum-member"
            ) {
              continue;
            }
            if (!widensAwayFrom(param, constraint, checker)) continue;
            const name = node.name?.getText() ?? "(anonymous)";
            found.push({
              node: param,
              carrier: "parameter",
              text: `${name}(${param.name.text}: ${param.type.getText()}) - ${callSites} call site(s)`,
              source: example,
              constraint,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return found;
}

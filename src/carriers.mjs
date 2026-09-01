// narrowing-loss: the declaration carriers besides fields.
//
// A field on a view model is not the only place a guarantee gets dropped.
// The same loss happens at a local annotation, a declared return type, or a
// cast — each is a declaration that says less than the value flowing into it:
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
import { constraintOfExpression } from "./census.mjs";
import { typeDropsConstraint } from "./fields.mjs";

function widened(expr, typeNode, checker) {
  if (!expr || !typeNode) return null;
  const constraint = constraintOfExpression(expr, checker);
  if (!constraint) return null;
  const type = checker.getTypeAtLocation(typeNode);
  if (!typeDropsConstraint(type, checker, constraint)) return null;
  return constraint;
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
        ts.isIdentifier(node.name)
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
            constraintOfExpression(el, checker),
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
      if (ts.isAsExpression(node)) {
        const constraint = widened(node.expression, node.type, checker);
        if (constraint) {
          found.push({
            node,
            carrier: "cast",
            text: node.getText().replace(/\s+/g, " ").slice(0, 60),
            source: node.expression,
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

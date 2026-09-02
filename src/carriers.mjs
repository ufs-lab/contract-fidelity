// contract-fidelity: the declaration carriers besides fields.
//
// A field on a view model is not the only place a guarantee gets dropped.
// The same loss happens at a parameter, a local annotation, a declared
// return type, or a cast - each is a declaration that says less than the
// value flowing into it:
//
//   function f(name: string | undefined) { ... }             // parameter
//   const name: string | undefined = account.entity.name;   // local
//   function f(a: AccountResponse): string | undefined {     // return type
//     return a.entity.name;
//   }
//   account.entity.name as string | undefined;               // cast
//
// A parameter, a local and a return slot are nodes of the graph, so their
// value is the join of everything that reaches them, across any number of
// calls and copies. A cast and a collection literal have exactly one value
// flowing into them at the site itself, so they are decided there, against
// the same graph.

import ts from "typescript";
import { guaranteeOfExpression } from "./census.mjs";
import { typeDropsConstraint } from "./fields.mjs";
import { widensAwayFrom } from "./analyze.mjs";
import { isGuarantee, sourceOf } from "./graph.mjs";

function isConstDeclaration(node) {
  const list = node.parent;
  return (
    list &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

function functionName(fn) {
  return fn.name?.getText() ?? "(anonymous)";
}

export function findWidenedDeclarations(graph, isScanned) {
  const { checker } = graph;
  const found = [];

  // const name: string | undefined = account.entity.name;
  //
  // A `let` annotated wider than its initialiser may be doing real work: the
  // wider type is there for a later assignment. Only a `const` is a node.
  for (const node of graph.consts()) {
    const decl = node.decl;
    if (!decl.type || !isScanned(decl.getSourceFile())) continue;
    const constraint = graph.valueOf(node);
    if (!isGuarantee(constraint)) continue;
    const type = checker.getTypeAtLocation(decl.type);
    if (!typeDropsConstraint(type, checker, constraint)) continue;
    found.push({
      node: decl,
      carrier: "local",
      text: `${decl.name.text}: ${decl.type.getText()}`,
      source: node.edges[0].expr,
      constraint,
    });
  }

  // function f(...): string | undefined { return account.entity.name }
  //
  // The slot's value is the join of every `return`: one that carries no
  // guarantee, a bare `return`, or a body that can fall off the end leaves
  // the wider type doing real work. An async slot holds the awaited value,
  // and is judged against the type inside the Promise.
  for (const node of graph.returns()) {
    const fn = node.decl;
    if (!fn.type || !isScanned(fn.getSourceFile())) continue;
    const constraint = graph.valueOf(node);
    if (!isGuarantee(constraint)) continue;
    const declared = graph.declaredTypeOf(node);
    if (!declared || !typeDropsConstraint(declared, checker, constraint)) {
      continue;
    }
    found.push({
      node: fn.type,
      carrier: "return type",
      text: `${functionName(fn)}(): ${fn.type.getText()}`,
      source: node.edges[0].expr,
      constraint,
      // The edit is inside the Promise, so the suggestion says so.
      wrapSuggestion: node.async ? (t) => `Promise<${t}>` : null,
    });
  }

  for (const sf of graph.program.getSourceFiles()) {
    if (!isScanned(sf)) continue;

    const visit = (node) => {
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
            guaranteeOfExpression(sourceOf(el), graph),
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
        const source = sourceOf(node.expression);
        const constraint = guaranteeOfExpression(source, graph);
        const type = checker.getTypeAtLocation(node.type);
        if (constraint && typeDropsConstraint(type, checker, constraint)) {
          found.push({
            node,
            carrier: "cast",
            text: node.getText().replace(/\s+/g, " ").slice(0, 60),
            // The value that really flows in, not the `as unknown` hop.
            source,
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

// A parameter declared wider than every value its callers hand it.
//
// The guard analysis reports a parameter only once somebody has written the
// dead check on it. The widening is falsifiable before that, against the
// census alone, and reporting it then is what stops the check being written.
export function findWidenedParameters(graph, isScanned) {
  const { checker } = graph;
  const found = [];
  for (const node of graph.parameters()) {
    const param = node.decl;
    if (!isScanned(param.getSourceFile())) continue;
    const constraint = graph.valueOf(node);
    if (!isGuarantee(constraint)) continue;
    // A doc-stated guarantee - `must be > 0`, `1-31`, `non-empty` - has no
    // narrower TypeScript type to move to, so a finding here would demand an
    // edit that does not exist. `dead-code` still enforces those, where a
    // dead guard proves the loss did harm.
    if (
      constraint.kind !== "required-non-null" &&
      constraint.kind !== "enum-member"
    ) {
      continue;
    }
    if (!widensAwayFrom(param, constraint, checker)) continue;
    found.push({
      node: param,
      carrier: "parameter",
      text: `${functionName(param.parent)}(${param.name.text}: ${param.type.getText()}) - ${node.calls} call site(s)`,
      // A real call rather than the declaration, which tells a reader
      // nothing they cannot already see.
      source: node.edges[0].expr,
      constraint,
    });
  }
  return found;
}

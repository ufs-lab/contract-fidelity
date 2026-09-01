// contract-fidelity: the call-site census.
//
// A guard inside a helper is dead only if EVERY caller hands it a value the
// contract already constrains. `textOrDash(value: string | null | undefined)`
// called eleven times with contract-required fields and once with a genuinely
// nullable local has a live `value == null` branch, and reporting it would be
// a false positive of the worst kind - the one that gets the linter switched
// off. So every callee-side finding is proven against all known call sites,
// and an unproven one is silently dropped.

import ts from "typescript";
import { constraintForClientProperty } from "./contract.mjs";
import { constraintFromType } from "./inferred.mjs";
import { getConfig } from "./program.mjs";

// How far to chase an argument that is a plain local back to its initialiser.
const ALIAS_DEPTH = 2;

// Index every call in the program by the function declaration it resolves to.
// Test files are INCLUDED here on purpose: a test that legitimately passes
// null proves the branch is reachable, and suppressing the finding is the
// right answer even though tests are not scanned for origins.
export function buildCallCensus(program, checker, isCandidateFile) {
  const byFunction = new Map();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isCandidateFile(sf)) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const sig = checker.getResolvedSignature(node);
        const decl = sig?.getDeclaration?.();
        if (decl) {
          if (!byFunction.has(decl)) byFunction.set(decl, []);
          byFunction.get(decl).push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return byFunction;
}

// The contract constraint an argument expression carries, if any.
export function constraintOfExpression(expr, checker, depth = 0) {
  if (!expr) return null;

  if (ts.isPropertyAccessExpression(expr)) {
    const symbol = checker.getSymbolAtLocation(expr.name);
    return symbol
      ? constraintForClientProperty(symbol, checker, expr.name)
      : null;
  }

  // A local that is just an alias for a contract field.
  if (ts.isIdentifier(expr) && depth < ALIAS_DEPTH) {
    const symbol = checker.getSymbolAtLocation(expr);
    const decl = symbol?.declarations?.[0];
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return constraintOfExpression(decl.initializer, checker, depth + 1);
    }
    if (decl && ts.isBindingElement(decl)) {
      const nameNode = decl.propertyName ?? decl.name;
      const s = checker.getSymbolAtLocation(nameNode);
      return s ? constraintForClientProperty(s, checker, nameNode) : null;
    }
  }

  return null;
}

// The guarantee an expression carries, from either source.
//
// A contract wins when there is one: it names a field a reader can look up,
// and it can state things no TypeScript type can. The checker's own type is
// the fallback, and it covers the far larger case where a value was never
// optional and somebody widened it anyway.
export function guaranteeOfExpression(expr, checker) {
  if (!expr) return null;
  const fromContract = constraintOfExpression(expr, checker);
  if (fromContract) return { ...fromContract, origin: "contract" };
  if (!getConfig().inferConstraints) return null;
  const label = expr.getText().replace(/\s+/g, " ").slice(0, 40);
  return constraintFromType(checker.getTypeAtLocation(expr), checker, label);
}

// The guarantee EVERY caller supplies for `paramDecl`, or null when unproven.
//
// The same census as the guard analysis, asked a weaker question: not "is
// some downstream check dead" but "is this parameter declared wider than
// every value it is ever given". A widening is falsifiable on its own, and
// waiting for someone to write the dead guard first means reporting the
// disease only after it has produced a symptom.
//
// Unproven is silent, on exactly the terms the guard analysis uses:
// no known call site, a spread, an omitted argument, or callers that
// disagree.
export function guaranteeAcrossCallSites(paramDecl, census, checker) {
  const fn = paramDecl.parent;
  const index = fn.parameters.indexOf(paramDecl);
  if (index < 0) return null;

  const calls = census.get(fn);
  if (!calls || calls.length === 0) return null;

  let shared = null;
  let example = null;
  for (const call of calls) {
    if (call.arguments.some(ts.isSpreadElement)) return null;
    const arg = call.arguments[index];
    if (!arg) return null;
    const constraint = guaranteeOfExpression(arg, checker);
    if (!constraint) return null;
    if (shared === null) {
      shared = constraint;
      // Kept so the finding can point at a real call rather than at the
      // declaration, which tells a reader nothing they cannot already see.
      example = arg;
    } else if (shared.kind !== constraint.kind) {
      return null;
    } else if (
      shared.kind === "enum-member" &&
      // Two callers passing different unions prove only their union, and
      // narrowing to either one would break the other.
      shared.members.join("|") !== constraint.members.join("|")
    ) {
      return null;
    }
  }
  return { constraint: shared, example, callSites: calls.length };
}

// Is `paramDecl`'s value constrained at EVERY call site, such that
// `decide(constraint)` gives the same verdict each time?
//
// Returns the shared verdict, or null when unproven - no known call sites,
// a caller that hands over an unconstrained value, or callers that disagree.
export function verdictAcrossCallSites(paramDecl, census, checker, decide) {
  const fn = paramDecl.parent;
  const index = fn.parameters.indexOf(paramDecl);
  if (index < 0) return null;

  const calls = census.get(fn);
  if (!calls || calls.length === 0) return null;

  let shared = null;
  for (const call of calls) {
    // A spread argument makes positional reasoning unsound.
    if (call.arguments.some(ts.isSpreadElement)) return null;
    const arg = call.arguments[index];
    // Fewer arguments than parameters: the parameter is undefined here, so
    // any nullish guard on it is genuinely live.
    if (!arg) return null;
    const constraint = constraintOfExpression(arg, checker);
    if (!constraint) return null;
    const verdict = decide(constraint);
    if (verdict === null || verdict === "undecided") return null;
    if (shared === null) shared = verdict;
    else if (shared !== verdict) return null;
  }
  return shared;
}

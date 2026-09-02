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
import { getConfig, isTestFile } from "./program.mjs";

// How far to chase an argument that is a plain local back to its initialiser.
const ALIAS_DEPTH = 2;

const FUNCTION_LIKE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
]);

// The function-like declarations an identifier can stand for.
//
// `const addScope = (s?: string) => ...` declares the function on the
// initialiser, and a parameter's `parent` is that initialiser, so that is the
// node the census keys on.
function functionsBehind(symbol) {
  const out = [];
  for (const decl of symbol?.declarations ?? []) {
    if (FUNCTION_LIKE_KINDS.has(decl.kind)) out.push(decl);
    else if (
      (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) &&
      decl.initializer &&
      FUNCTION_LIKE_KINDS.has(decl.initializer.kind)
    ) {
      out.push(decl.initializer);
    }
  }
  return out;
}

// Is this identifier a use of the value itself, rather than a call of it?
//
// `addScope(x)` and `<Row />` are calls: the census sees the arguments. Every
// other use hands the function to somebody else, who will call it with
// arguments this census will never read. Returns the node to test - for
// `obj.method` the whole property access, since that is what gets passed.
function valueUseNode(id) {
  const parent = id.parent;
  if (!parent) return null;

  // `{ addScope }` passes the function; every other `name:` position is a
  // declaration or a label, not a use.
  if (
    parent.name === id &&
    !ts.isShorthandPropertyAssignment(parent) &&
    !ts.isPropertyAccessExpression(parent)
  ) {
    return null;
  }
  // An import or export binding is not itself a use. `export default Cell`
  // and `export { addRow }` name the function; whoever imports it then calls
  // it or passes it on, and under `closedWorld` that site is in this program
  // and this census reads it there. Counting the export itself as a use would
  // put every exported component out of reach of the write census.
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isExportAssignment(parent)
  ) {
    return null;
  }

  const node =
    ts.isPropertyAccessExpression(parent) && parent.name === id ? parent : id;
  const owner = node.parent;
  if (!owner) return node;

  // The callee of a call is a call, not a value use.
  if (
    (ts.isCallExpression(owner) ||
      ts.isNewExpression(owner) ||
      ts.isTaggedTemplateExpression(owner)) &&
    owner.expression === node
  ) {
    return null;
  }
  if (ts.isDecorator(owner) && owner.expression === node) return null;
  // A JSX tag is a call of the component with the attributes as its props.
  if (
    (ts.isJsxOpeningElement(owner) ||
      ts.isJsxSelfClosingElement(owner) ||
      ts.isJsxClosingElement(owner)) &&
    owner.tagName === node
  ) {
    return null;
  }
  return node;
}

// Index every call in the program by the function declaration it resolves to,
// and record every function that is handed around as a VALUE.
//
// Test files are INCLUDED here on purpose: a test that legitimately passes
// null proves the branch is reachable, and suppressing the finding is the
// right answer even though tests are not scanned for origins.
export function buildCallCensus(program, checker, isCandidateFile) {
  const byFunction = new Map();
  // Function-like declarations whose calls this census cannot enumerate,
  // because the function was passed somewhere as a value.
  const valueReferenced = new Set();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isCandidateFile(sf)) continue;
    const visit = (node) => {
      // A type node holds no calls and no value uses. `class A extends
      // mixin(Base)` is the exception: TypeScript files a heritage clause
      // under the type nodes, and the call in it is a real call.
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
        return;
      }
      if (ts.isCallExpression(node)) {
        const sig = checker.getResolvedSignature(node);
        const decl = sig?.getDeclaration?.();
        if (decl) {
          if (!byFunction.has(decl)) byFunction.set(decl, []);
          byFunction.get(decl).push(node);
        }
      }
      if (ts.isIdentifier(node) && valueUseNode(node)) {
        // `{ addScope }` binds a property symbol to the name; the value it
        // passes on is the symbol the shorthand stands for.
        let symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        for (const fn of functionsBehind(symbol)) valueReferenced.add(fn);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return { byFunction, valueReferenced };
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

  // A function handed to somebody else as a VALUE is called from places this
  // census cannot read: `Object.keys(x).forEach(addScope)` calls addScope once
  // per key, with arguments no call expression in this program names. The
  // census then holds the direct calls only, and proving a parameter from them
  // is proving it from a fraction of its callers. `addScope(scope?: string |
  // null)` was reported "1 call site" three lines above the forEach that is
  // its real caller.
  if (census.valueReferenced.has(fn)) return null;

  const calls = census.byFunction.get(fn);
  if (!calls || calls.length === 0) return null;

  // A test passes whatever the test needs. It proves a branch is REACHABLE,
  // which is why the census reads tests at all, and it proves nothing about
  // what production always supplies. The field census has always said so; the
  // parameter census did not, and an overload signature whose single caller
  // was its own `.test.ts` was reported for exactly that reason.
  if (calls.every((call) => isTestFile(call.getSourceFile().fileName))) {
    return null;
  }

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

  // Calls this census cannot enumerate - see guaranteeAcrossCallSites.
  if (census.valueReferenced.has(fn)) return null;

  const calls = census.byFunction.get(fn);
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

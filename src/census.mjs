// contract-fidelity: the call-site census, and the guarantee readers.
//
// A guard inside a helper is dead only if EVERY caller hands it a value the
// contract already constrains. `textOrDash(value: string | null | undefined)`
// called eleven times with contract-required fields and once with a genuinely
// nullable local has a live `value == null` branch, and reporting it would be
// a false positive of the worst kind - the one that gets the linter switched
// off. So every callee-side finding is proven against all known call sites,
// and an unproven one is silently dropped.
//
// The census indexes the calls. The graph (graph.mjs) turns them into edges
// and solves every parameter alongside every field, local and return slot.

import ts from "typescript";
import { constraintForClientProperty } from "./contract.mjs";

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

// The contract a property read states about its own value, at the site.
export function directContract(expr, checker) {
  if (!expr || !ts.isPropertyAccessExpression(expr)) return null;
  const symbol = checker.getSymbolAtLocation(expr.name);
  return symbol ? constraintForClientProperty(symbol, checker, expr.name) : null;
}

// The checker's type for a value, as written.
//
// A JSX string attribute is the one expression the checker leaves untyped:
// `getTypeAtLocation` on the `"dark"` in `tone="dark"` is `any`, and a
// census that took that at face value read every such write as stating
// nothing. It is a string.
export function typeOfWrite(expr, checker) {
  if (ts.isStringLiteral(expr) && ts.isJsxAttribute(expr.parent)) {
    return checker.getStringType();
  }
  return checker.getTypeAtLocation(expr);
}

// The guarantee an expression carries, from either source, through the
// solved graph.
//
// A contract wins when there is one: it names a field a reader can look up,
// and it can state things no TypeScript type can. The checker's own type is
// the fallback, and it covers the far larger case where a value was never
// optional and somebody widened it anyway. A plain read of a proven
// declaration carries that declaration's value, under the site-identity rule
// the graph enforces.
export function guaranteeOfExpression(expr, graph) {
  if (!expr) return null;
  return graph.guaranteeOf(expr);
}

// The contract guarantee alone. A `const` that copies a contract field, or a
// binding destructured from one, carries the contract; the checker's own
// inference does not count here.
export function constraintOfExpression(expr, graph) {
  if (!expr) return null;
  return graph.contractOf(expr);
}

// Is `paramDecl`'s value constrained at EVERY call site, such that
// `decide(constraint)` gives the same verdict each time?
//
// Returns the shared verdict, or null when unproven - no known call sites,
// a caller that hands over an unconstrained value, or callers that disagree.
export function verdictAcrossCallSites(paramDecl, graph, decide) {
  const { census } = graph;
  const fn = paramDecl.parent;
  const index = fn.parameters.indexOf(paramDecl);
  if (index < 0) return null;

  // A function handed to somebody else as a VALUE is called from places this
  // census cannot read: `Object.keys(x).forEach(addScope)` calls addScope once
  // per key, with arguments no call expression in this program names.
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
    const constraint = constraintOfExpression(arg, graph);
    if (!constraint) return null;
    const verdict = decide(constraint);
    if (verdict === null || verdict === "undecided") return null;
    if (shared === null) shared = verdict;
    else if (shared !== verdict) return null;
  }
  return shared;
}

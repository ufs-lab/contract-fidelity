// contract-fidelity: the whole-program value graph and its least fixed point.
//
// Every declaration that can be wider than the values reaching it is a node:
// an annotated parameter, an owned field, a `const` local, a destructured
// binding, and the return slot of a function with a body. Every value flow
// into one of them is an edge: a call argument, a field write, a return
// expression, an initialiser, a destructuring read.
//
// A node holds one value from a lattice of height two:
//
//          TOP        a flow the census cannot read, or writers that disagree
//        /     \
//    NN(T)   Enum(U)   (plus the doc-stated contract kinds `dead-code` uses)
//        \     /
//         BOTTOM       nothing observed, or unreachable
//
// NN(T) says every value is present and of type T. Enum(U) says every value
// is a member of the named string-literal union U. The join of two different
// guarantees is TOP, so a node rises at most twice, and a worklist from
// BOTTOM terminates.
//
// Only a guarantee is ever reported. TOP is silent: unproven. That is the
// rule the one-hop censuses always had, written as a lattice. What the
// lattice adds is transitivity: a proven parameter feeds the parameter it is
// passed on to, a proven return slot feeds the `const` that receives it, and
// one run reports the whole chain.
//
// BOTTOM is where a node with edges starts, and what an unreachable edge
// contributes. It is not the value of a node with no edge at all: an empty
// census proves nothing, so a parameter nobody calls is TOP, and a value
// passed on from it proves nothing downstream either. Starting the nodes
// that do have edges at BOTTOM is what lets a recursive call converge: the
// self edge contributes nothing until the external callers have spoken, and
// then agrees with them.
//
// The rule that keeps transitivity sound is the site-identity rule. A node's
// value is a fact about its declaration. The checker's type at a reference
// can be narrower (`x` after a guard), wider (`o?.f`), or `never` (an
// exhausted switch), and in each case the expression is no longer a plain
// read of the declaration. So an edge through expression `e` contributes:
//
//   1. the contract `e` reads directly;
//   2. the source node's value when it is a contract fact and the type at `e`
//      is mutually assignable with the source's declared type;
//   3. the guarantee the type at `e` states on its own;
//   4. the source node's value, on the same identity condition;
//   5. TOP.
//
// A `never` at `e` contributes BOTTOM: the edge is unreachable.

import ts from "typescript";
import { constraintForClientProperty } from "./contract.mjs";
import { constraintFromType } from "./inferred.mjs";
import { getConfig, isTestFile } from "./program.mjs";
import { buildCallCensus, directContract, typeOfWrite } from "./census.mjs";
import {
  buildFieldWriteIndex,
  fieldWidens,
  isProducedElsewhere,
  typesProducedOutsideLiterals,
} from "./fields.mjs";

export const BOTTOM = Symbol("bottom");
export const TOP = Symbol("top");

export function isGuarantee(value) {
  return value !== BOTTOM && value !== TOP && value != null;
}

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
]);

// `x as unknown as T` is the shape people reach for when the compiler
// objects. The intermediate hop states nothing, so reading the type at the
// outer cast finds `unknown` and the laundering hides behind its own
// mechanism. Look through it to the value that actually flows in.
export function sourceOf(expr) {
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
      ts.isExportAssignment(node)
    ) {
      return true;
    }
    if (ts.isSourceFile(node)) return false;
  }
  return false;
}

function isConstDeclaration(node) {
  const list = node.parent;
  return (
    list &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

function isAsync(fn) {
  const modifiers = ts.canHaveModifiers?.(fn) ? ts.getModifiers(fn) : fn.modifiers;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

// `arguments` reads the call positionally, past anything the parameter list
// names. Arrow functions do not bind it, so the search descends into them and
// stops at the next function that does.
function usesArguments(fn) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      node !== fn &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "arguments" &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

// Every `return` a body can produce, without descending into nested
// functions, whose returns belong to them. A bare `return` is recorded as
// such: it is a return of `undefined`.
function returnStatements(body) {
  const out = [];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

export function buildGraph(program, checker, { rootDir, isCandidateFile }) {
  const census = buildCallCensus(program, checker, isCandidateFile);
  const index = buildFieldWriteIndex(
    program,
    checker,
    isCandidateFile,
    rootDir,
    census.valueReferenced,
  );
  const producedElsewhere = typesProducedOutsideLiterals(
    program,
    checker,
    isCandidateFile,
  );
  const { closedWorld, inferConstraints } = getConfig();

  // Every node is keyed on its declaration node, so a generic type
  // instantiated three ways and a `Partial<T>` over it all resolve to the one
  // field, and a call through any instantiation of a function resolves to
  // the one parameter.
  const params = new Map();
  const fields = new Map();
  const consts = new Map();
  const bindings = new Map();
  const returns = new Map();
  const all = [];

  const makeNode = (kind, decl, extra) => {
    const node = {
      kind,
      decl,
      edges: [],
      top: false,
      value: BOTTOM,
      ...extra,
    };
    all.push(node);
    return node;
  };

  // The type the declaration states, against which a reference is tested
  // for identity. An async function's slot holds the awaited value: that is
  // what its `return` expressions supply and what `await f()` reads.
  const declaredTypeOf = (node) => {
    if (node.declaredType !== undefined) return node.declaredType;
    let type = null;
    if (node.kind === "return") {
      const fn = node.decl;
      type = fn.type
        ? checker.getTypeAtLocation(fn.type)
        : (checker.getSignatureFromDeclaration(fn)?.getReturnType() ?? null);
      if (type && node.async) type = checker.getAwaitedType(type) ?? type;
    } else if (node.symbol) {
      type = checker.getTypeOfSymbolAtLocation(node.symbol, node.decl);
    }
    node.declaredType = type;
    return type;
  };

  const mutuallyAssignable = (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (typeof checker.isTypeAssignableTo !== "function") return false;
    return checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
  };

  // The awaited type, and whether awaiting changed anything. `await x` on a
  // value that is not a promise is the value itself.
  const unwrap = (type) => {
    const awaited = checker.getAwaitedType(type) ?? type;
    return {
      type: awaited,
      unwrapped: awaited !== type && !mutuallyAssignable(awaited, type),
    };
  };

  // --- Nodes ---------------------------------------------------------------

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isCandidateFile(sf)) continue;
    const visit = (node) => {
      if (FUNCTION_LIKE.has(node.kind)) {
        for (const param of node.parameters) {
          // No annotation means nothing was widened, and a rest parameter
          // receives a list no positional census can name.
          if (!param.type || !ts.isIdentifier(param.name)) continue;
          if (param.dotDotDotToken || param.name.text === "this") continue;
          const symbol = checker.getSymbolAtLocation(param.name);
          if (!symbol) continue;
          params.set(param, makeNode("parameter", param, { symbol, calls: 0 }));
        }
        if (node.body) {
          returns.set(
            node,
            makeNode("return", node, { async: isAsync(node) }),
          );
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isConstDeclaration(node)
      ) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) consts.set(node, makeNode("const", node, { symbol }));
      }
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        !node.dotDotDotToken &&
        ts.isObjectBindingPattern(node.parent) &&
        bindsConstOrParameter(node)
      ) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) bindings.set(node, makeNode("binding", node, { symbol }));
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  for (const [symbol, { writes, disqualified }] of index) {
    const decl = symbol.declarations?.[0];
    if (!decl) continue;
    const node = makeNode("field", decl, { symbol, writes });
    fields.set(decl, node);
    // A write the census cannot read, or a shape whose values arrive from
    // somewhere the census cannot see: nothing about the field is provable.
    if (disqualified || isProducedElsewhere(symbol, producedElsewhere)) {
      node.top = true;
    }
  }

  // A `let` binding may be reassigned, and a `catch` binding holds whatever
  // was thrown. Only a `const` pattern or a parameter pattern reads one
  // property into one name for good.
  function bindsConstOrParameter(element) {
    let cur = element.parent;
    while (cur && (ts.isObjectBindingPattern(cur) || ts.isBindingElement(cur))) {
      cur = cur.parent;
    }
    if (!cur) return false;
    if (ts.isParameter(cur)) return true;
    return ts.isVariableDeclaration(cur) && isConstDeclaration(cur);
  }

  // --- Reference resolution --------------------------------------------------

  // The node an expression is a plain read of, if any. `opened` says an
  // `await` took a value out of a promise on the way.
  const referencedNode = (expr, opened) => {
    let e = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isAwaitExpression(e)) {
      e = e.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      opened = opened || unwrap(checker.getTypeAtLocation(e)).unwrapped;
    }
    let node = null;
    if (ts.isIdentifier(e)) {
      let symbol =
        ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e
          ? checker.getShorthandAssignmentValueSymbol(e.parent)
          : checker.getSymbolAtLocation(e);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (decl) {
        node = params.get(decl) ?? consts.get(decl) ?? bindings.get(decl) ?? null;
      }
    } else if (ts.isPropertyAccessExpression(e)) {
      const symbol = checker.getSymbolAtLocation(e.name);
      const decl = symbol?.declarations?.[0];
      if (decl) node = fields.get(decl) ?? null;
    } else if (ts.isCallExpression(e)) {
      const decl = checker.getResolvedSignature(e)?.getDeclaration?.();
      if (decl) node = returns.get(decl) ?? null;
    }
    if (!node) return null;
    return { node, opened };
  };

  // --- Edges -----------------------------------------------------------------

  // An edge is resolved once: what the expression states on its own, and
  // which node it reads. Only the node's value is read at solve time.
  const makeEdge = (expr, { awaited = false } = {}) => {
    let type = typeOfWrite(expr, checker);
    let opened = false;
    if (awaited) ({ type, unwrapped: opened } = unwrap(type));
    const contract = directContract(expr, checker);
    const edge = {
      expr,
      never: (type.flags & ts.TypeFlags.Never) !== 0,
      // Built once, so the solver compares one object with itself.
      contract: contract ? { ...contract, origin: "contract" } : null,
      inferred: inferConstraints
        ? constraintFromType(
            type,
            checker,
            expr.getText().replace(/\s+/g, " ").slice(0, 40),
          )
        : null,
      src: null,
    };
    const ref = referencedNode(expr, awaited && opened);
    if (ref) {
      const { node } = ref;
      // A value taken out of a promise is described only by an async slot,
      // which holds the awaited value by construction. Any other node whose
      // declared type still matches here can only be `any`, which matches
      // everything and describes nothing.
      const opaque =
        (ref.opened || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) &&
        !(node.kind === "return" && node.async);
      if (!opaque && mutuallyAssignable(type, declaredTypeOf(node))) {
        edge.src = node;
      }
    }
    return edge;
  };

  const addEdge = (node, edge) => {
    node.edges.push(edge);
  };

  // Parameters: one edge per positional argument at each censused call.
  for (const [fn, calls] of census.byFunction) {
    if (!FUNCTION_LIKE.has(fn.kind)) continue;
    const positional = fn.parameters.filter(
      (p) => !(ts.isIdentifier(p.name) && p.name.text === "this"),
    );
    const nodes = positional.map((p) => params.get(p) ?? null);
    if (nodes.every((n) => n === null)) continue;
    // A function handed to somebody else as a value is called from places
    // this census cannot read, and a library's exports are called by code
    // this program will never see.
    const unreadable =
      census.valueReferenced.has(fn) ||
      (!closedWorld && isExported(fn)) ||
      usesArguments(fn) ||
      // A test passes whatever the test needs. It proves a branch is
      // REACHABLE, which is why the census reads tests at all, and it proves
      // nothing about what production always supplies.
      calls.every((call) => isTestFile(call.getSourceFile().fileName));
    for (const node of nodes) {
      if (node) node.calls = calls.length;
    }
    if (unreadable) {
      for (const node of nodes) if (node) node.top = true;
      continue;
    }
    for (const call of calls) {
      // A spread argument makes positional reasoning unsound.
      const spread = call.arguments.some(ts.isSpreadElement);
      nodes.forEach((node, i) => {
        if (!node) return;
        const arg = call.arguments[i];
        // Fewer arguments than parameters: the parameter is undefined here.
        if (spread || !arg) node.top = true;
        else addEdge(node, makeEdge(arg));
      });
    }
  }
  // Fields: one edge per censused write.
  for (const node of fields.values()) {
    if (node.top) continue;
    const { writes } = node;
    if (
      writes.length > 0 &&
      writes.every((expr) => isTestFile(expr.getSourceFile().fileName))
    ) {
      node.top = true;
      continue;
    }
    for (const expr of writes) addEdge(node, makeEdge(expr));
  }

  // Return slots: one edge per `return` expression. A body that can complete
  // normally, a bare `return`, or a generator returns something no edge
  // names, so the slot is unproven.
  for (const [fn, node] of returns) {
    if (fn.asteriskToken) {
      node.top = true;
      continue;
    }
    const awaited = node.async;
    if (!ts.isBlock(fn.body)) {
      addEdge(node, makeEdge(sourceOf(fn.body), { awaited }));
      continue;
    }
    const statements = returnStatements(fn.body);
    if (
      statements.some((s) => !s.expression) ||
      completesNormally(fn.body, checker)
    ) {
      node.top = true;
      continue;
    }
    for (const s of statements) {
      addEdge(node, makeEdge(sourceOf(s.expression), { awaited }));
    }
  }

  // Constants: the initialiser.
  for (const [decl, node] of consts) {
    addEdge(node, makeEdge(sourceOf(decl.initializer)));
  }

  // Bindings: the property the pattern reads. The site type is the
  // binding's own type, which already reflects a default.
  for (const [element, node] of bindings) {
    const nameNode = element.propertyName ?? element.name;
    const name =
      ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode)
        ? nameNode.text
        : null;
    const patternType = checker.getTypeAtLocation(element.parent);
    const property = name ? checker.getPropertyOfType(patternType, name) : null;
    if (!property) {
      node.top = true;
      continue;
    }
    const type = checker.getTypeOfSymbolAtLocation(node.symbol, element);
    const contract = constraintForClientProperty(property, checker, element.name);
    const edge = {
      expr: element.name,
      never: (type.flags & ts.TypeFlags.Never) !== 0,
      contract: contract ? { ...contract, origin: "contract" } : null,
      inferred: inferConstraints
        ? constraintFromType(type, checker, name)
        : null,
      src: null,
    };
    const propertyDecl = property.declarations?.[0];
    const source = propertyDecl ? fields.get(propertyDecl) : null;
    if (source && mutuallyAssignable(type, declaredTypeOf(source))) {
      edge.src = source;
    }
    addEdge(node, edge);
  }

  // --- Solve -----------------------------------------------------------------

  const valueOf = (node) =>
    node.top || node.edges.length === 0 ? TOP : node.value;

  const evaluate = (edge) => {
    if (edge.never) return BOTTOM;
    if (edge.contract) return edge.contract;
    const through = edge.src ? valueOf(edge.src) : TOP;
    if (isGuarantee(through) && through.origin === "contract") return through;
    if (edge.inferred) return edge.inferred;
    return through;
  };

  const join = (a, b) => {
    if (a === BOTTOM) return b;
    if (b === BOTTOM) return a;
    if (a === TOP || b === TOP) return TOP;
    return sameGuarantee(a, b, checker) ? a : TOP;
  };

  const fold = (node) => {
    let acc = BOTTOM;
    for (const edge of node.edges) {
      acc = join(acc, evaluate(edge));
      if (acc === TOP) break;
    }
    return acc;
  };

  const dependents = new Map();
  for (const node of all) {
    for (const edge of node.edges) {
      if (!edge.src) continue;
      if (!dependents.has(edge.src)) dependents.set(edge.src, new Set());
      dependents.get(edge.src).add(node);
    }
  }
  const queue = all.filter((node) => !node.top && node.edges.length > 0);
  const queued = new Set(queue);
  while (queue.length > 0) {
    const node = queue.pop();
    queued.delete(node);
    if (node.top) continue;
    const value = fold(node);
    if (value === node.value) continue;
    node.value = value;
    for (const dependent of dependents.get(node) ?? []) {
      if (!queued.has(dependent)) {
        queued.add(dependent);
        queue.push(dependent);
      }
    }
  }

  // --- Reads -----------------------------------------------------------------

  // The guarantee an expression carries at its site, through the solved
  // graph: what a cast, a collection element, or a re-derived verdict asks.
  const guaranteeOf = (expr) => {
    const value = evaluate(makeEdge(expr));
    return isGuarantee(value) ? value : null;
  };

  // The contract guarantee an expression carries, and nothing the checker
  // inferred: what the `dead-code` cross-call path asks.
  const contractOf = (expr) => {
    const value = guaranteeOf(expr);
    return value && value.origin === "contract" ? value : null;
  };

  return {
    program,
    checker,
    census,
    valueOf,
    guaranteeOf,
    contractOf,
    parameters: () => params.values(),
    fields: () => fields.values(),
    consts: () => consts.values(),
    returns: () => returns.values(),
    declaredTypeOf,
  };
}

// Fields where EVERY write supplies the same guarantee, and the field's own
// declared type has dropped it. A write that reads a proven field, parameter,
// local or return slot carries that node's guarantee, however many copies
// deep.
export function constrainedFields(graph) {
  const { checker } = graph;
  const out = new Map();
  for (const node of graph.fields()) {
    const constraint = graph.valueOf(node);
    if (!isGuarantee(constraint)) continue;
    if (!fieldWidens(node.symbol, checker, constraint)) continue;
    out.set(node.symbol, { constraint, writes: node.writes });
  }
  return out;
}

// Two guarantees are the same fact when a declaration narrowed to either
// would accept every value of the other.
export function sameGuarantee(a, b, checker) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "enum-member") {
    const left = new Set(a.members);
    return (
      b.members.length === left.size && b.members.every((m) => left.has(m))
    );
  }
  if (a.kind === "required-non-null") {
    if (a.type && b.type) {
      if (a.type === b.type) return true;
      if (typeof checker.isTypeAssignableTo !== "function") return false;
      return (
        checker.isTypeAssignableTo(a.type, b.type) &&
        checker.isTypeAssignableTo(b.type, a.type)
      );
    }
    return a.sourceType === b.sourceType;
  }
  if (a.interval && b.interval) {
    return (
      a.interval.lo === b.interval.lo &&
      a.interval.hi === b.interval.hi &&
      a.interval.loExclusive === b.interval.loExclusive &&
      a.interval.hiExclusive === b.interval.hiExclusive
    );
  }
  return true;
}

// Can control fall off the end of this block? A body that can returns
// `undefined` on that path, so its return slot is unproven.
//
// The check is structural: `return`, `throw`, a call to a function that
// returns `never`, and a branch whose every arm ends. A loop is assumed to
// complete, because proving `while (true)` never breaks is not this tool's
// job.
export function completesNormally(block, checker) {
  return !endsFlow(block, checker);
}

function endsFlow(statement, checker) {
  if (!statement) return false;
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return true;
  }
  if (ts.isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1];
    return endsFlow(last, checker);
  }
  if (ts.isIfStatement(statement)) {
    return (
      endsFlow(statement.thenStatement, checker) &&
      endsFlow(statement.elseStatement, checker)
    );
  }
  if (ts.isLabeledStatement(statement)) {
    return endsFlow(statement.statement, checker);
  }
  if (ts.isSwitchStatement(statement)) {
    const clauses = statement.caseBlock.clauses;
    if (!clauses.some(ts.isDefaultClause)) return false;
    // An empty clause falls through to the next one.
    let next = false;
    for (let i = clauses.length - 1; i >= 0; i--) {
      const statements = clauses[i].statements;
      const ends =
        statements.length === 0
          ? next
          : endsFlow(statements[statements.length - 1], checker);
      if (!ends) return false;
      next = ends;
    }
    return true;
  }
  if (ts.isTryStatement(statement)) {
    if (statement.finallyBlock && endsFlow(statement.finallyBlock, checker)) {
      return true;
    }
    return (
      endsFlow(statement.tryBlock, checker) &&
      (!statement.catchClause ||
        endsFlow(statement.catchClause.block, checker))
    );
  }
  if (ts.isExpressionStatement(statement)) {
    const type = checker.getTypeAtLocation(statement.expression);
    return (type.flags & ts.TypeFlags.Never) !== 0;
  }
  return false;
}

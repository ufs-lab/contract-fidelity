// narrowing-loss: guarantees dropped into a field rather than a parameter.
//
// The commonest way a contract guarantee goes missing in this codebase is
// not a function parameter — it is a view model or a props type:
//
//   interface Row { entityName: string | null }        // wider than the API
//   const row: Row = { entityName: acc.entity.name };  // contract: required
//   ...
//   row.entityName ?? "—"                              // dead
//
// TypeScript cannot help here: by the time the value is in `row.entityName`
// its type really is nullable, so `no-unnecessary-condition` is right to stay
// quiet. Only knowing where the field's values COME FROM makes the guard
// visibly dead.
//
// The reasoning mirrors census.mjs: a guard on a read is dead only if every
// write into that field supplies a guaranteed value. A single unaccounted
// write — a spread, an assignment we cannot resolve — disqualifies the field
// entirely.

import ts from "typescript";
import { constraintOfExpression } from "./census.mjs";
import { dropsGuarantee } from "./analyze.mjs";

// A field whose declared type still carries the guarantee has not widened,
// and a guard on it is TypeScript's business, not ours.
// Does `type` fail to carry `constraint`? Shared by every carrier — a field,
// a local, a return type, a cast — because they all ask the same question:
// is this declaration wider than the contract value flowing into it?
export function typeDropsConstraint(type, checker, constraint) {
  if (constraint.kind === "required-non-null") {
    return dropsGuarantee(type, checker);
  }
  if (constraint.kind === "enum-member") {
    // Widened the moment it is no longer a union of string literals.
    return !(type.isUnion() && type.types.every((p) => p.isStringLiteral()));
  }
  // Doc-stated guarantees have no narrower TypeScript type to move to — see
  // the note in fieldWidens.
  return false;
}

function fieldWidens(target, checker, constraint) {
  const decl = target.declarations?.[0];
  if (!decl) return false;
  const type = checker.getTypeOfSymbolAtLocation(target, decl);
  if (constraint.kind === "required-non-null") {
    const optional = (target.flags & ts.SymbolFlags.Optional) !== 0;
    if (optional) return true;
  }
  // Doc-stated guarantees — `must be > 0`, `1-31`, `non-empty` — have no
  // narrower TypeScript type to move to. `hitRate?: number` fed by an
  // optional `hit_rate` already mirrors its source faithfully; it is flagged
  // only because the RANGE cannot be expressed, and no edit to this file can
  // fix that. Reporting it would be asking for a change that does not exist.
  //
  // Those guarantees are still enforced — by `no-narrowing-loss`, which needs
  // a dead guard to prove the loss did harm. This rule covers only the kinds
  // where a narrower type is actually available: required-non-null and enums.
  return typeDropsConstraint(type, checker, constraint);
}

// Only fields declared in our own source are ours to fix; a field on a
// library or client type is not.
function isOwnedField(target, rootDir) {
  const file = target.declarations?.[0]?.getSourceFile();
  if (!file) return false;
  return file.fileName.includes(`${rootDir}/src/`) && !file.isDeclarationFile;
}

// Types whose values can arrive from somewhere the write census cannot see.
//
// The census indexes object literals, JSX attributes and property
// assignments. It cannot see a value that arrives by deserialization:
//
//   interface ProbeResponse { data: { version?: string } }
//   callApi: (signal: AbortSignal) => Promise<ProbeResponse>;
//
// Every ProbeResponse but one is produced by an HTTP call, so "every writer
// supplies a guaranteed value" was true of the one literal we could see and
// false of the wire. Narrowing `version` there would make the type lie about
// what the probe actually returns — and HealthCheckService says in a comment
// that some probes carry no version at all.
//
// The tell is a function TYPE (no body, so nothing to index) returning the
// type inside a PROMISE: that is the shape of fetching. A synchronous
// `() => AccountListItemVM[]` is not — its implementation is ours and its
// returns are literals the census already sees, which is how every
// view-model builder works. Requiring the Promise keeps view models in scope
// and takes response shapes out.
function typesProducedOutsideLiterals(program, checker, isCandidateFile) {
  const names = new Set();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isCandidateFile(sf)) continue;
    const visit = (node) => {
      if (
        ts.isFunctionTypeNode(node) ||
        ts.isMethodSignature(node) ||
        ts.isCallSignatureDeclaration(node)
      ) {
        // Only inside a Promise: everything the awaited value contains could
        // have been deserialized rather than constructed.
        const collectInside = (t) => {
          if (!t) return;
          if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
            names.add(t.typeName.text);
          }
          ts.forEachChild(t, collectInside);
        };
        const findPromise = (t) => {
          if (!t) return;
          if (
            ts.isTypeReferenceNode(t) &&
            ts.isIdentifier(t.typeName) &&
            t.typeName.text === "Promise"
          ) {
            t.typeArguments?.forEach(collectInside);
            return;
          }
          ts.forEachChild(t, findPromise);
        };
        findPromise(node.type);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return names;
}

// The nearest named type a field belongs to, so it can be matched against the
// set above. A field on an inline literal inherits its enclosing interface.
function enclosingTypeName(decl) {
  for (let node = decl.parent; node; node = node.parent) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      return node.name.text;
    }
  }
  return null;
}

// Index every write into every locally-declared field.
//
// Test files are included for the same reason as in census.mjs: a test that
// writes an unconstrained value proves a guard on the read is live.
export { typesProducedOutsideLiterals };

export function buildFieldWriteIndex(
  program,
  checker,
  isCandidateFile,
  rootDir,
) {
  const index = new Map(); // target symbol -> { writes: [], disqualified: bool }

  const entry = (target) => {
    if (!index.has(target))
      index.set(target, { writes: [], disqualified: false });
    return index.get(target);
  };

  const disqualifyPropsOf = (type) => {
    if (!type) return;
    for (const prop of checker.getPropertiesOfType(type))
      entry(prop).disqualified = true;
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isCandidateFile(sf)) continue;

    const visit = (node) => {
      // `{ field: expr }` against a contextual type
      if (ts.isObjectLiteralExpression(node)) {
        const contextual = checker.getContextualType(node);
        if (contextual) {
          for (const prop of node.properties) {
            if (ts.isSpreadAssignment(prop)) {
              // Values could arrive from anywhere this object was spread from.
              disqualifyPropsOf(checker.getTypeAtLocation(prop.expression));
              continue;
            }
            const name =
              prop.name && ts.isIdentifier(prop.name)
                ? prop.name.text
                : prop.name && ts.isStringLiteralLike(prop.name)
                  ? prop.name.text
                  : null;
            if (!name) continue;
            const target = checker.getPropertyOfType(contextual, name);
            if (!target || !isOwnedField(target, rootDir)) continue;
            if (ts.isPropertyAssignment(prop))
              entry(target).writes.push(prop.initializer);
            else if (ts.isShorthandPropertyAssignment(prop))
              entry(target).writes.push(prop.name);
            else entry(target).disqualified = true;
          }
        }
      }

      // `<Component field={expr} />`
      if (ts.isJsxAttribute(node) && node.initializer) {
        const target = checker.getSymbolAtLocation(node.name);
        if (target && isOwnedField(target, rootDir)) {
          const init = node.initializer;
          if (ts.isJsxExpression(init) && init.expression) {
            entry(target).writes.push(init.expression);
          } else {
            entry(target).disqualified = true;
          }
        }
      }
      if (ts.isJsxSpreadAttribute(node)) {
        disqualifyPropsOf(checker.getTypeAtLocation(node.expression));
      }

      // `obj.field = expr`
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left)
      ) {
        const target = checker.getSymbolAtLocation(node.left.name);
        if (target && isOwnedField(target, rootDir))
          entry(target).writes.push(node.right);
      }

      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return index;
}

// Fields where EVERY write supplies the same guarantee, and the field's own
// declared type has dropped it.
export function constrainedFields(index, checker, rootDir, producedElsewhere) {
  const proven = new Map(); // target symbol -> constraint, for transitive use
  const out = new Map();

  // A write carries a guarantee if it reads a client property, OR if it reads
  // a local field already proven to carry one.
  const constraintOfWrite = (expr) => {
    const direct = constraintOfExpression(expr, checker);
    if (direct) return direct;
    if (ts.isPropertyAccessExpression(expr)) {
      const sym = checker.getSymbolAtLocation(expr.name);
      if (sym && proven.has(sym)) return proven.get(sym);
    }
    return null;
  };

  // Resolved to a FIXED POINT, because a guarantee survives being copied. A
  // view-model field fed from another view-model field whose own writes are
  // all contract-constrained still carries the contract's guarantee — but on
  // a single pass its writes resolve to a local field, not a client property,
  // and the whole field is skipped in silence.
  //
  // That is how CurrencyExposureAccountDetailVM was missed: it mirrored a
  // query type field for field, and surfaced only when narrowing its source
  // broke the typecheck. Iterating until nothing new is proven closes it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [target, { writes, disqualified }] of index) {
      if (proven.has(target) || disqualified || writes.length === 0) continue;

      let shared = null;
      let ok = true;
      for (const expr of writes) {
        const c = constraintOfWrite(expr);
        if (!c) {
          ok = false;
          break;
        }
        if (shared === null) shared = c;
        else if (shared.kind !== c.kind) {
          ok = false;
          break;
        }
      }
      if (!ok || !shared) continue;

      // A shape whose values can arrive by deserialization proves NOTHING,
      // not even transitively. Its census is incomplete, so letting it seed
      // the proven map would launder a guarantee it does not have into every
      // field downstream of it — which is how ServiceHealth.version came to
      // be reported off the back of ProbeResponse.
      if (producedElsewhere) {
        const owner = enclosingTypeName(target.declarations?.[0] ?? {});
        if (owner && producedElsewhere.has(owner)) continue;
      }

      proven.set(target, shared);
      changed = true;

      if (!fieldWidens(target, checker, shared)) continue;
      out.set(target, { constraint: shared, writes });
    }
  }
  return out;
}

// Re-derive a guard's verdict at every write site; unanimity or nothing.
export function verdictAcrossWrites(writes, checker, decide) {
  let shared = null;
  for (const expr of writes) {
    const c = constraintOfExpression(expr, checker);
    if (!c) return null;
    const verdict = decide(c);
    if (verdict === null || verdict === "undecided") return null;
    if (shared === null) shared = verdict;
    else if (shared !== verdict) return null;
  }
  return shared;
}

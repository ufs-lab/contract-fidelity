// contract-fidelity: guarantees dropped into a field rather than a parameter.
//
// The commonest way a contract guarantee goes missing in this codebase is
// not a function parameter - it is a view model or a props type:
//
//   interface Row { entityName: string | null }        // wider than the API
//   const row: Row = { entityName: acc.entity.name };  // contract: required
//   ...
//   row.entityName ?? "-"                              // dead
//
// TypeScript cannot help here: by the time the value is in `row.entityName`
// its type really is nullable, so `no-unnecessary-condition` is right to stay
// quiet. Only knowing where the field's values COME FROM makes the guard
// visibly dead.
//
// The reasoning mirrors census.mjs: a guard on a read is dead only if every
// write into that field supplies a guaranteed value. A single unaccounted
// write - a spread, an assignment we cannot resolve - disqualifies the field
// entirely.

import ts from "typescript";
import { isScannedPath, isTestFile } from "./program.mjs";
import { guaranteeOfExpression } from "./census.mjs";
import { onlyNullishWasAdded } from "./inferred.mjs";
import { dropsGuarantee } from "./analyze.mjs";

const ASSIGNMENT_OPS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const isAssignment = (kind) => ASSIGNMENT_OPS.has(kind);

// Calls that write fields by name at runtime. What they write is not an
// expression this census can read, so every field of the target is unproven.
const MUTATORS = new Map([
  ["Object", new Set(["assign", "defineProperty", "defineProperties"])],
  ["Reflect", new Set(["set", "defineProperty", "deleteProperty"])],
]);

// A field whose declared type still carries the guarantee has not widened,
// and a guard on it is TypeScript's business, not ours.
// Does `type` fail to carry `constraint`? Shared by every carrier - a field,
// a local, a return type, a cast - because they all ask the same question:
// is this declaration wider than the contract value flowing into it?
export function typeDropsConstraint(type, checker, constraint) {
  if (constraint.kind === "required-non-null") {
    if (!dropsGuarantee(type, checker)) return false;
    // A contract states the field is required, and any nullish declaration
    // contradicts it. An INFERRED guarantee is weaker: it says only that the
    // values seen so far were present, so the report is confined to the one
    // shape with a mechanical fix, where nullish is all that was added.
    if (constraint.origin === "inferred") {
      return onlyNullishWasAdded(type, constraint, checker);
    }
    return true;
  }
  if (constraint.kind === "enum-member") {
    // Widened the moment it is no longer a union of string literals.
    return !(type.isUnion() && type.types.every((p) => p.isStringLiteral()));
  }
  // Doc-stated guarantees have no narrower TypeScript type to move to - see
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
  // Doc-stated guarantees - `must be > 0`, `1-31`, `non-empty` - have no
  // narrower TypeScript type to move to. `hitRate?: number` fed by an
  // optional `hit_rate` already mirrors its source faithfully; it is flagged
  // only because the RANGE cannot be expressed, and no edit to this file can
  // fix that. Reporting it would be asking for a change that does not exist.
  //
  // Those guarantees are still enforced - by `dead-code`, which needs
  // a dead guard to prove the loss did harm. This rule covers only the kinds
  // where a narrower type is actually available: required-non-null and enums.
  return typeDropsConstraint(type, checker, constraint);
}

// Only fields declared in our own source are ours to fix; a field on a
// library or client type is not.
function isOwnedField(target, rootDir) {
  const file = target.declarations?.[0]?.getSourceFile();
  if (!file) return false;
  return isScannedPath(file.fileName, rootDir) && !file.isDeclarationFile;
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
// what the probe actually returns - and HealthCheckService says in a comment
// that some probes carry no version at all.
//
// The tell is a function TYPE (no body, so nothing to index) returning the
// type inside a PROMISE: that is the shape of fetching. A synchronous
// `() => AccountListItemVM[]` is not - its implementation is ours and its
// returns are literals the census already sees, which is how every
// view-model builder works. Requiring the Promise keeps view models in scope
// and takes response shapes out.
function typesProducedOutsideLiterals(program, checker, isCandidateFile) {
  const names = new Set();
  // Property declarations reached through a cast target that has no name to
  // collect: `clone(x) as Base & { examples?: unknown }`. The literal's
  // `examples` is a declaration like any other, and a value cast INTO it
  // arrived from outside the census exactly as a named type's would.
  const decls = new Set();
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

      // `JSON.parse(raw) as Stored`, `config as RetryableRequestConfig`,
      // `clone(x) as Base & { examples?: unknown }`.
      //
      // A cast says the value did not come from a literal this census can
      // read: it was parsed, received, or borrowed from a library. Every
      // write the census DOES see for such a type is then only a fraction of
      // the values it holds, and proving anything from that fraction is how a
      // localStorage settings shape got reported as always-present when its
      // whole reason to be optional was records written before the field
      // existed.
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const collectTargets = (t) => {
          if (!t) return;
          if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
            names.add(t.typeName.text);
          }
          if (ts.isTypeLiteralNode(t)) {
            for (const member of t.members) decls.add(member);
          }
          ts.forEachChild(t, collectTargets);
        };
        collectTargets(node.type);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  names.decls = decls;
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
  valueReferenced = null,
) {
  const index = new Map(); // target symbol -> { writes: [], disqualified: bool }

  // One census per DECLARATION, whatever symbol instance a write resolves to.
  //
  // A generic type instantiated three ways yields three property symbols for
  // one field, and a mapped type (Partial<T>, Pick<T, K>) yields another. Each
  // symbol carried its own write list, so a null written through one
  // instantiation could not disqualify a field proven through a second, and
  // an omission seen through Partial<T> never reached the declared field at
  // all. `ReportInput<K, T>.data` was reported four times from one line for
  // exactly this reason, while the arm that wrote null sat in a fifth census
  // nobody consulted. Every instance still points at the same declaration,
  // so that is the key.
  const canonical = new Map(); // declaration node -> the symbol we index under
  const keyOf = (symbol) => {
    const decl = symbol?.declarations?.[0];
    if (!decl) return symbol;
    if (!canonical.has(decl)) {
      const declared = decl.name
        ? checker.getSymbolAtLocation(decl.name)
        : null;
      canonical.set(decl, declared ?? symbol);
    }
    return canonical.get(decl);
  };

  const entry = (rawTarget) => {
    const target = keyOf(rawTarget);
    if (!index.has(target))
      index.set(target, { writes: [], disqualified: false });
    return index.get(target);
  };

  // Every object-like member of a type, so a union slot is read member by
  // member rather than through the properties they happen to share.
  const objectMembers = (type) =>
    (type.isUnion() ? type.types : [type]).filter(
      // A React component's attributes are contextually typed
      // `IntrinsicAttributes & Props`: an INTERSECTION, which is object-like
      // but does not carry the Object flag. Dropping it here silenced both the
      // omission rule and the spread rule for every React.FC in the program,
      // so an optional prop one render path omitted was proven from the path
      // that supplied it.
      (m) =>
        (m.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) !== 0,
    );

  // A write the census cannot read at all: every field of the type could now
  // hold anything.
  const disqualifyEveryFieldOf = (type) => {
    if (!type) return;
    for (const shape of objectMembers(type)) {
      for (const prop of checker.getPropertiesOfType(shape)) {
        if (isOwnedField(prop, rootDir)) entry(prop).disqualified = true;
      }
    }
  };

  // A spread writes the fields of the TARGET, with whatever the SOURCE holds.
  //
  //   const vm: RowVM = { ...row };      // row: ApiRow
  //   <Row {...props} />
  //
  // The census used to disqualify the fields of the SOURCE type, which are
  // the fields nothing was written into: a spread READS its source. So
  // `RowVM.name` stayed proven from the one literal elsewhere that supplied
  // it, while `{ ...row }` was free to put `null` there. A target field whose
  // source field is optional, nullable, or absent can be absent too, and the
  // only sound answer is to disqualify it.
  //
  // `suppliedAfter` holds the names written AFTER the spread in the same
  // literal, which the spread cannot reach: `{ ...row, name: "x" }` supplies
  // `name` whatever `row` holds.
  const disqualifyFromSpread = (targetShape, sourceExpr, suppliedAfter) => {
    const sourceType = checker.getTypeAtLocation(sourceExpr);
    for (const targetProp of checker.getPropertiesOfType(targetShape)) {
      const name = targetProp.getName();
      if (suppliedAfter.has(name)) continue;
      if (!isOwnedField(targetProp, rootDir)) continue;
      const sourceProp = sourceType
        ? checker.getPropertyOfType(sourceType, name)
        : null;
      const optional = (prop) => (prop.flags & ts.SymbolFlags.Optional) !== 0;
      // `{ ...state, count: n }` spreads a type into itself. Every field
      // joins with itself, so nothing new arrives and nothing is disproven.
      //
      // That exemption is about the TYPE, not the property. A property-level
      // test - same declaration, same optionality - exempted a Partial-typed
      // object built from the props: every property of a Partial keeps the
      // props field's declaration, and for an already-optional prop the
      // optionality matches too. Only a source whose type IS the target type
      // is a self-spread.
      if (sourceType?.symbol && sourceType.symbol === targetShape.symbol) {
        continue;
      }
      const unsafe =
        !sourceProp ||
        optional(sourceProp) ||
        dropsGuarantee(
          checker.getTypeOfSymbolAtLocation(sourceProp, sourceExpr),
          checker,
        );
      if (unsafe) entry(targetProp).disqualified = true;
    }
  };

  // The name a property or JSX attribute writes, when it is written plainly.
  const writtenName = (prop) =>
    prop.name &&
    (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
      ? prop.name.text
      : null;

  // A string key that names one field. `o[k] = e` with a computed key names
  // no field, and is handled as a write the census cannot read.
  const literalKey = (expr) =>
    expr && (ts.isStringLiteralLike(expr) ? expr.text : null);

  // A function that is handed around as a value is called from places this
  // census cannot read, and an unseen call site builds its own arguments:
  // `component={AccountCell}` is rendered by ag-Grid with a props object ag-
  // Grid constructs, and `rows.forEach(addRow)` calls addRow with whatever
  // the library holds. So every field of every parameter type of such a
  // function receives values no literal in this program supplies.
  for (const fn of valueReferenced ?? []) {
    for (const param of fn.parameters ?? []) {
      disqualifyEveryFieldOf(checker.getTypeAtLocation(param));
    }
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isCandidateFile(sf)) continue;

    const visit = (node) => {
      // `{ field: expr }` against a contextual type
      if (ts.isObjectLiteralExpression(node)) {
        const contextual = checker.getContextualType(node);
        // `useState<S>` and `SetStateAction<S>` hand a literal a UNION as its
        // contextual type. `getPropertyOfType` on a union returns only the
        // properties common to every member, so against `S | ((prev: S) => S)`
        // it returns nothing and the write was silently dropped from the
        // census. A dropped write is the most dangerous outcome there is: it
        // is the `lastRequest: null` that would have disqualified the field.
        // Resolve against each object-like member instead.
        const shapes = contextual
          ? (contextual.isUnion() ? contextual.types : [contextual]).filter(
              (t) => (t.flags & ts.TypeFlags.Object) !== 0,
            )
          : [];
        for (const shape of shapes) {
          const contextual = shape;
          // OMITTING an optional field is a write of "absent".
          //
          // Without this the census sees only the literals that supply the
          // field and never the ones that leave it out, so a field written in
          // three places and omitted in thirty reads as always-present. On a
          // real codebase that was about three quarters of every finding:
          // options bags, result types where the payload is absent on
          // failure, and optional component props. Several carried the
          // author's own comment saying so - "omitted when no previous data
          // available" - one line above the field the tool proposed to
          // narrow.
          //
          // The call census has always applied this rule: an omitted argument
          // means unproven. This is the same rule, for the same reason.
          const supplied = new Set(
            node.properties
              .map(writtenName)
              .filter((name) => name !== null),
          );
          for (const candidate of checker.getPropertiesOfType(contextual)) {
            const optional =
              (candidate.flags & ts.SymbolFlags.Optional) !== 0;
            if (
              optional &&
              !supplied.has(candidate.getName()) &&
              isOwnedField(candidate, rootDir)
            ) {
              entry(candidate).disqualified = true;
            }
          }
          node.properties.forEach((prop, at) => {
            if (ts.isSpreadAssignment(prop)) {
              const after = new Set(
                node.properties
                  .slice(at + 1)
                  .map(writtenName)
                  .filter((name) => name !== null),
              );
              disqualifyFromSpread(contextual, prop.expression, after);
              return;
            }
            const name = writtenName(prop);
            if (!name) return;
            const target = checker.getPropertyOfType(contextual, name);
            if (!target || !isOwnedField(target, rootDir)) return;
            if (ts.isPropertyAssignment(prop))
              entry(target).writes.push(prop.initializer);
            else if (ts.isShorthandPropertyAssignment(prop))
              entry(target).writes.push(prop.name);
            else entry(target).disqualified = true;
          });
        }
      }

      // `<Component field={expr} />`, the props it leaves out, and the props
      // a `{...spread}` supplies.
      //
      // The attribute write is keyed on the PROPS FIELD, through the
      // contextual props type. `checker.getSymbolAtLocation(attr.name)`
      // returns a symbol whose declaration is the JsxAttribute node itself,
      // and no read of the props type ever resolves to that symbol, so every
      // JSX write - 22,781 of them in the application this tool was measured
      // on - landed in a census nobody consulted. A props field written
      // `<C x={maybe} />` was then proven non-null from the one object
      // literal elsewhere that supplied it.
      //
      // Omission is a write of "absent", for the reason the object literal
      // rule gives above: a prop passed at two call sites and left out at
      // twenty is not a prop every caller supplies.
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const propsType = checker.getContextualType?.(node.attributes);
        const attributes = node.attributes.properties;
        const attributeName = (attr) =>
          ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name)
            ? attr.name.text
            : null;
        if (propsType) {
          const supplied = new Set(
            attributes.map(attributeName).filter((name) => name !== null),
          );
          for (const shape of objectMembers(propsType)) {
            for (const candidate of checker.getPropertiesOfType(shape)) {
              if (
                (candidate.flags & ts.SymbolFlags.Optional) !== 0 &&
                !supplied.has(candidate.getName()) &&
                isOwnedField(candidate, rootDir)
              ) {
                entry(candidate).disqualified = true;
              }
            }
          }

          attributes.forEach((attr, at) => {
            if (ts.isJsxSpreadAttribute(attr)) {
              // A later attribute overrides the spread: `<C {...p} x={1} />`.
              const after = new Set(
                attributes
                  .slice(at + 1)
                  .map(attributeName)
                  .filter((name) => name !== null),
              );
              for (const shape of objectMembers(propsType)) {
                disqualifyFromSpread(shape, attr.expression, after);
              }
              return;
            }
            const name = attributeName(attr);
            if (name === null) return;
            for (const shape of objectMembers(propsType)) {
              const target = checker.getPropertyOfType(shape, name);
              if (!target || !isOwnedField(target, rootDir)) continue;
              const init = attr.initializer;
              // `<C flag />` writes `true`, and `<C x={} />` writes nothing
              // this census can read.
              if (!init) entry(target).disqualified = true;
              else if (!ts.isJsxExpression(init))
                entry(target).writes.push(init);
              else if (init.expression)
                entry(target).writes.push(init.expression);
              else entry(target).disqualified = true;
            }
          });
        }
      }

      // A WHOLE object of one declared type flowing into a slot of another.
      //
      //   <TrendArrow indicator={row} />      // row: RuntimeIndicator
      //   useSlot(x)                          // x: Src, slot: Slot
      //
      // No literal writes `Slot.v` here, so the per-field census never sees
      // this flow, and `Slot.v` was proven from the one literal elsewhere that
      // did supply it. But every field of Slot receives whatever the source
      // type's field holds. When the source field is optional, nullable or
      // absent, the slot's field can be absent too, and the only sound answer
      // is to disqualify it. TrendArrow.trendPercentage was reported, and
      // narrowing it produced six compile errors, for exactly this reason.
      //
      // Only disqualification is applied here. A present source field is not
      // pushed as a write, because there is no expression to push; the slot
      // then rests on its literal writes, or stays unproven. Sound either way.
      const wholeObjectSlots = [];
      if (ts.isJsxExpression(node) && node.expression) {
        wholeObjectSlots.push(node.expression);
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        for (const arg of node.arguments ?? []) wholeObjectSlots.push(arg);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        wholeObjectSlots.push(node.right);
      } else if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
        wholeObjectSlots.push(node.initializer);
      } else if (ts.isReturnStatement(node) && node.expression) {
        wholeObjectSlots.push(node.expression);
      } else if (ts.isPropertyAssignment(node)) {
        wholeObjectSlots.push(node.initializer);
      }
      for (const expr of wholeObjectSlots) {
        if (ts.isObjectLiteralExpression(expr) || ts.isSpreadElement(expr)) {
          continue; // a literal is censused field by field above
        }
        const slotType = checker.getContextualType(expr);
        const valueType = checker.getTypeAtLocation(expr);
        if (!slotType || !valueType) continue;
        for (const slot of objectMembers(slotType)) {
          for (const value of objectMembers(valueType)) {
            if (slot === value) continue;
            if (slot.symbol && slot.symbol === value.symbol) continue;
            for (const slotProp of checker.getPropertiesOfType(slot)) {
              if ((slotProp.flags & ts.SymbolFlags.Optional) === 0) continue;
              if (!isOwnedField(slotProp, rootDir)) continue;
              const sourceProp = value.getProperty(slotProp.getName());
              const absent =
                !sourceProp ||
                (sourceProp.flags & ts.SymbolFlags.Optional) !== 0 ||
                dropsGuarantee(
                  checker.getTypeOfSymbolAtLocation(sourceProp, expr),
                  checker,
                );
              if (absent) entry(slotProp).disqualified = true;
            }
          }
        }
      }

      // `obj.field = expr`, `obj["field"] = expr`, and the mutations that
      // write a value the census cannot read.
      //
      //   obj.field = expr        a write, censused like a literal
      //   obj["field"] = expr     the same write, spelled differently
      //   obj[key] = expr         some field of obj, and we do not know which
      //   obj.field ??= expr      a write whose value is not `expr` alone
      //   delete obj.field        a write of "absent"
      //   Object.assign(obj, x)   every field of obj, from a value we cannot
      //                           read field by field
      //
      // `Settings.theme` was proven present while `s["theme"] = null` sat two
      // lines below the literal that proved it.
      if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
        const plain = node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        const write = (target) => {
          if (!target || !isOwnedField(target, rootDir)) return;
          if (plain) entry(target).writes.push(node.right);
          else entry(target).disqualified = true;
        };
        if (ts.isPropertyAccessExpression(node.left)) {
          write(checker.getSymbolAtLocation(node.left.name));
        } else if (ts.isElementAccessExpression(node.left)) {
          const key = literalKey(node.left.argumentExpression);
          const objType = checker.getTypeAtLocation(node.left.expression);
          if (key === null) disqualifyEveryFieldOf(objType);
          else {
            for (const shape of objectMembers(objType)) {
              write(checker.getPropertyOfType(shape, key));
            }
          }
        }
      }

      // `obj.field++`: a write whose value is arithmetic on the old one.
      if (
        (ts.isPostfixUnaryExpression(node) ||
          ts.isPrefixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isPropertyAccessExpression(node.operand)
      ) {
        const target = checker.getSymbolAtLocation(node.operand.name);
        if (target && isOwnedField(target, rootDir))
          entry(target).disqualified = true;
      }

      if (ts.isDeleteExpression(node)) {
        const removed = node.expression;
        if (ts.isPropertyAccessExpression(removed)) {
          const target = checker.getSymbolAtLocation(removed.name);
          if (target && isOwnedField(target, rootDir))
            entry(target).disqualified = true;
        } else if (ts.isElementAccessExpression(removed)) {
          const key = literalKey(removed.argumentExpression);
          const objType = checker.getTypeAtLocation(removed.expression);
          if (key === null) disqualifyEveryFieldOf(objType);
          else {
            for (const shape of objectMembers(objType)) {
              const target = checker.getPropertyOfType(shape, key);
              if (target && isOwnedField(target, rootDir))
                entry(target).disqualified = true;
            }
          }
        }
      }

      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.arguments.length > 0 &&
        MUTATORS.get(node.expression.expression.text)?.has(
          node.expression.name.text,
        )
      ) {
        disqualifyEveryFieldOf(checker.getTypeAtLocation(node.arguments[0]));
      }

      // `private rafId: number | null = null;`
      //
      // The declaration's own initialiser is a write, and missing it made the
      // census read a field as always-present when its resting value is null.
      // `sceneEngine.rafId` was exactly this: two `requestAnimationFrame`
      // assignments were counted, the `= null` beside the type was not, and
      // the tool proposed narrowing away the very case the field exists to
      // represent.
      if (ts.isPropertyDeclaration(node) && node.initializer) {
        const target = checker.getSymbolAtLocation(node.name);
        if (target && isOwnedField(target, rootDir))
          entry(target).writes.push(node.initializer);
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
    const direct = guaranteeOfExpression(expr, checker);
    if (direct) return direct;
    if (ts.isPropertyAccessExpression(expr)) {
      const sym = checker.getSymbolAtLocation(expr.name);
      if (sym && proven.has(sym)) return proven.get(sym);
    }
    return null;
  };

  // Resolved to a FIXED POINT, because a guarantee survives being copied. A
  // view-model field fed from another view-model field whose own writes are
  // all contract-constrained still carries the contract's guarantee - but on
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
      // A test supplies whatever the test needs. It proves a branch is
      // REACHABLE, which is why the census reads tests at all, but it cannot
      // prove that production always supplies a value. Two findings in a
      // sample of thirty rested on a single write in a `.test.ts`.
      if (writes.every((expr) => isTestFile(expr.getSourceFile().fileName))) {
        continue;
      }

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
      // field downstream of it - which is how ServiceHealth.version came to
      // be reported off the back of ProbeResponse.
      if (producedElsewhere?.decls?.has(target.declarations?.[0])) continue;
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
    const c = guaranteeOfExpression(expr, checker);
    if (!c) return null;
    const verdict = decide(c);
    if (verdict === null || verdict === "undecided") return null;
    if (shared === null) shared = verdict;
    else if (shared !== verdict) return null;
  }
  return shared;
}

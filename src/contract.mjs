// contract-fidelity: reading the contract off a generated-client symbol.
//
// The generated clients are the boundary this linter cares about:
// values arriving from them carry guarantees the TypeScript type does not
// state. This module turns a resolved symbol into the constraint its
// contract states, or null when the contract states nothing decidable.

import ts from "typescript";
import { constraintFromDoc, compileDocPatterns } from "./constraints.mjs";

// pnpm resolves the clients through the content-addressed store, so the
// package name appears mid-path (`node_modules/.pnpm/@acme+...`) and a prefix
// test would miss every one of them. The scopes themselves are configured -
// see config.mjs.
import { contractPathRe, getConfig } from "./program.mjs";

// Compiled once. `docPatterns` is the extension point for a generator whose
// prose the built-in patterns do not recognise; an invalid entry throws here
// rather than silently contributing nothing.
let cachedDocPatterns = null;
function projectDocPatterns() {
  cachedDocPatterns ??= compileDocPatterns(getConfig().docPatterns);
  return cachedDocPatterns;
}

export function isClientDeclaration(decl) {
  const file = decl?.getSourceFile?.();
  return file ? contractPathRe().test(file.fileName) : false;
}

// A guarantee is something the API PROMISES ABOUT DATA IT SENDS. The generated
// clients also export enum values as const objects:
//
//   export declare const EntityScope: { readonly ENTITY_SCOPE_HOUSE: "HOUSE" };
//
// Those members are PropertySignatures in a client file just like real
// response fields are, so a path/kind test alone reads
// `EntityScope.ENTITY_SCOPE_HOUSE` as "a value that arrived from the API".
// It is a literal constant written by us, and nothing downstream of it is
// defending against the boundary. Only a member of an `interface` counts.
function isDataContractMember(decl) {
  // An index signature (`[key: string]: any` on a free-form metadata bag)
  // states nothing about any particular key. `extra_metadata.linked_ledger_id`
  // resolves to it, and reading that as "the contract guarantees this field"
  // would call a genuinely necessary `unknown` annotation a widening.
  if (ts.isIndexSignatureDeclaration(decl)) return false;

  // Only DATA members carry a contract guarantee. On the class templates a
  // model also declares getters, setters and methods, and every one of them
  // has a non-nullable function type - read as "required non-null" they would
  // each become a fake guarantee. Lob's SDK yielded 519 of them.
  if (!ts.isPropertySignature(decl) && !ts.isPropertyDeclaration(decl)) {
    return false;
  }

  for (let node = decl.parent; node; node = node.parent) {
    // openapi-generator emits models as interfaces (typescript-axios) or as
    // CLASSES (typescript-node - Lob's and Klaviyo's SDKs both use it).
    // Recognising only interfaces made the scan pass vacuously on the class
    // templates: contract files found, no guarantees read, "clean" reported.
    if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
      return true;
    }
    if (ts.isVariableDeclaration(node) || ts.isVariableStatement(node))
      return false;
  }
  return false;
}

// The JSDoc attached to the property, joined into one string.
function docTextFor(symbol, checker) {
  const parts = symbol.getDocumentationComment(checker);
  return ts.displayPartsToString(parts);
}

function isOptionalProperty(symbol) {
  return (symbol.flags & ts.SymbolFlags.Optional) !== 0;
}

function typeIncludesNullish(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some(
    (t) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0,
  );
}

// A generated enum is `export type X = typeof X[keyof typeof X]`, which the
// checker resolves to a union of string literals. Requiring every member to
// be a string literal keeps `string`-widened aliases out.
function stringLiteralMembers(type) {
  if (!type.isUnion()) return null;
  const members = [];
  for (const part of type.types) {
    if (!part.isStringLiteral()) return null;
    members.push(part.value);
  }
  return members.length >= 2 ? members : null;
}

function isArrayLike(type, checker) {
  return checker.isArrayType?.(type) ?? false;
}

// What `typeof` and `Array.isArray` would say about a value of this type.
// Recorded so a runtime type test against a guaranteed value can be decided.
export function baseKindOf(type, checker) {
  if (isArrayLike(type, checker)) return "array";
  const parts = type.isUnion() ? type.types : [type];
  const nonNullish = parts.filter(
    (p) => (p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0,
  );
  if (nonNullish.length === 0) return null;
  const kindOf = (p) => {
    if (p.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral))
      return "string";
    if (p.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral))
      return "number";
    if (p.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral))
      return "boolean";
    if (p.flags & ts.TypeFlags.Object) return "object";
    return null;
  };
  const kinds = new Set(nonNullish.map(kindOf));
  return kinds.size === 1 ? [...kinds][0] : null;
}

// Resolve the constraint a client property states about its own value.
// `symbol` must be the property symbol as declared in the client.
export function constraintForClientProperty(symbol, checker, atNode) {
  const decl = symbol.declarations?.[0];
  if (!decl || !isClientDeclaration(decl)) return null;
  if (!isDataContractMember(decl)) return null;

  const type = checker.getTypeOfSymbolAtLocation(symbol, atNode ?? decl);
  const doc = docTextFor(symbol, checker);

  // Doc-stated guarantees come first: they are the ones TypeScript cannot
  // see at all, so they are the highest-value findings.
  const baseKind = baseKindOf(type, checker);

  // A numeric guarantee only means anything about a NUMERIC field. Klaviyo's
  // `operator` is an enum of operator names whose description reads
  // `e.g. "between 10 and 20 days ago"` - that prose matched the range pattern
  // and, because doc parsing runs first, overrode the correct enum
  // classification and declared a string field to be a number in [10, 20].
  // Gating on the field's own type kills the class: a description is evidence
  // about the value only where it agrees with the type.
  const fromDoc = constraintFromDoc(doc, {
    isArray: isArrayLike(type, checker),
    extraPatterns: projectDocPatterns(),
  });
  if (fromDoc && (!fromDoc.numeric || baseKind === "number")) {
    return { ...fromDoc, field: symbol.getName(), baseKind };
  }

  // The type to narrow TO, printed the way a developer would write it.
  // `typeToString` prefers an alias symbol, so an enum union comes back as
  // `EntityScope` rather than its members spelled out. This is what turns a
  // finding into an instruction.
  const sourceType = checker.typeToString(type);

  const members = stringLiteralMembers(type);
  if (members) {
    return {
      kind: "enum-member",
      members,
      sourceType,
      why: `the contract pins this to ${members.join(" | ")}`,
      source: doc.split(/(?<=[.;])\s+/)[0]?.trim() ?? "",
      field: symbol.getName(),
      baseKind,
    };
  }

  if (!isOptionalProperty(symbol) && !typeIncludesNullish(type)) {
    return {
      kind: "required-non-null",
      sourceType,
      why: "the contract declares this required and non-null",
      source: doc.split(/(?<=[.;])\s+/)[0]?.trim() ?? "",
      field: symbol.getName(),
      baseKind,
      isObjectLike: (type.flags & ts.TypeFlags.Object) !== 0,
    };
  }

  return null;
}

// Human-readable "which contract said so", e.g. `AccountCodeCreateInput.site_id`.
//
// Classes count, not just interfaces: `isDataContractMember` accepts the
// typescript-node template deliberately, so naming only interfaces here
// printed `(anonymous).field` for every model in those SDKs and made the
// finding unsearchable.
export function contractPathFor(symbol) {
  const decl = symbol.declarations?.[0];
  const owner = decl?.parent;
  const named =
    owner &&
    (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) &&
    owner.name;
  return `${named ? owner.name.text : "(anonymous)"}.${symbol.getName()}`;
}

// How many guarantees the contract actually yields. A scan that finds contract
// FILES but reads no guarantees from them reports "clean" while checking
// nothing - the worst failure a linter can have, because it looks like a pass.
// Lob's SDK is a real example: every generated property is `private "_x"?:`,
// so there is nothing to enforce and the run is vacuous by construction.
export function countContractGuarantees(program, checker) {
  let count = 0;
  for (const sf of program.getSourceFiles()) {
    if (!isClientFile(sf)) continue;
    const visit = (node) => {
      if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
        for (const member of node.members) {
          if (!member.name) continue;
          const symbol = checker.getSymbolAtLocation(member.name);
          if (!symbol) continue;
          if (constraintForClientProperty(symbol, checker, member.name))
            count++;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return count;
}

export function isClientFile(sourceFile) {
  return contractPathRe().test(sourceFile.fileName);
}

// contract-fidelity: guarantees the CHECKER states, with no contract involved.
//
// The contract-anchored analysis only fires where a generated client
// contradicts a widened declaration. That is a narrow overlap. The same
// laundering happens with no contract in sight:
//
//   function label(name: string | undefined) { ... }   // every caller passes string
//   const scope = row.scope as string;                 // row.scope is an enum union
//
// In both cases a type that carried information was replaced by one that
// carries less, and the defensive code written downstream then looks
// necessary to the reviewer and to the compiler alike. The contract was never
// the point; the LOSS was. So the checker's own type is a second source of
// guarantees, on exactly the same terms as a contract field.
//
// Two kinds only, both decidable and both with an obvious fix:
//
//   required-non-null   the type has no nullish part
//   enum-member         the type is a union of string literals
//
// Anything else is silent. `any` and `unknown` state nothing by definition,
// and a type parameter states nothing until it is instantiated.

import ts from "typescript";
import { baseKindOf } from "./contract.mjs";

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

// `any` and `unknown` are the absence of a claim, not a claim. A type
// parameter is a promise about some future instantiation, so reading it as a
// guarantee here would be unsound.
function statesNothing(type) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (type.flags & ts.TypeFlags.Never) return true;
  if (type.flags & ts.TypeFlags.TypeParameter) return true;
  const parts = type.isUnion() ? type.types : [type];
  return parts.some(
    (part) =>
      part.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter),
  );
}

function includesNullish(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) => (part.flags & NULLISH) !== 0);
}

function stringLiteralMembers(type) {
  if (!type.isUnion()) return null;
  const members = [];
  for (const part of type.types) {
    if (!part.isStringLiteral()) return null;
    members.push(part.value);
  }
  return members.length >= 2 ? members : null;
}

// A literal type is not a narrowing target.
//
// One caller passing `"What this page is"` does not mean the prop should be
// typed `"What this page is"`. Measured against a real codebase, this was the
// single largest source of nonsense findings: the tool proposed narrowing a
// title to the one title it had seen, an object field to `true`, and a row to
// `"Total"`. The value is a literal; the DECLARATION was never meant to be.
function isLiteralish(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some(
    (part) =>
      (part.flags &
        (ts.TypeFlags.StringLiteral |
          ts.TypeFlags.NumberLiteral |
          ts.TypeFlags.BooleanLiteral |
          ts.TypeFlags.BigIntLiteral |
          ts.TypeFlags.UniqueESSymbol)) !==
      0,
  );
}

// Does the printed type read as a name a developer could write down?
//
// `CycleRunStateEnum` is a decision the codebase has already made, and
// narrowing to it is a one-word edit anyone can review. A spelled-out union
// of two prose sentences is an implementation detail that happens to be a
// union, and proposing it as an annotation is noise.
function isNamedType(printed) {
  return /^[A-Za-z_$][\w$.]*(<.*>)?(\[\])?$/.test(printed);
}

// The guarantee a type states about any value of that type.
//
// `label` names the thing in a message, since there is no contract field to
// name. Returns null when the type states nothing worth enforcing.
export function constraintFromType(type, checker, label) {
  if (!type || statesNothing(type)) return null;

  const sourceType = checker.typeToString(type);

  const members = stringLiteralMembers(type);
  if (members) {
    // The union itself IS literals, so isLiteralish does not apply here; what
    // matters is whether it has a name worth narrowing to.
    if (!isNamedType(sourceType)) return null;
    return {
      kind: "enum-member",
      origin: "inferred",
      members,
      sourceType,
      type,
      why: `every value here is ${members.join(" | ")}`,
      source: "",
      field: label,
      baseKind: "string",
    };
  }

  if (isLiteralish(type)) return null;

  if (!includesNullish(type)) {
    return {
      kind: "required-non-null",
      origin: "inferred",
      sourceType,
      // Kept so the carrier can ask the stricter question: is the declared
      // type this type with nullish added, and nothing else?
      type,
      why: "every value here is present and non-null",
      source: "",
      field: label,
      // The KIND, not the printed type. Setting this to a type string made
      // every `typeof` and `Array.isArray` verdict garbage: `Array.isArray`
      // on a mapped array was decided "always-false", because the string
      // "unknown[]" is not the word "array".
      baseKind: baseKindOf(type, checker),
      isObjectLike: (type.flags & ts.TypeFlags.Object) !== 0,
    };
  }

  return null;
}

// For an INFERRED non-null guarantee, the only shape worth reporting is a
// declaration that is the source type with nullish bolted on.
//
// Without this, every `?:` in the codebase whose one caller happens to pass a
// value becomes a finding, including the many where the wider type is the
// deliberate design. Requiring the two types to differ ONLY by the nullish
// part leaves exactly the mechanical case: delete the `| undefined`. It also
// removes findings whose suggestion made no sense, such as narrowing
// `unknown[]` to `unknown[]`, or narrowing to a type that still contains
// `null`.
export function onlyNullishWasAdded(declaredType, constraint, checker) {
  const source = constraint.type;
  if (!source || !declaredType) return false;
  if (typeof checker.isTypeAssignableTo !== "function") return false;
  const stripped = checker.getNonNullableType(declaredType);
  if (statesNothing(stripped)) return false;
  return (
    checker.isTypeAssignableTo(source, stripped) &&
    checker.isTypeAssignableTo(stripped, source)
  );
}

// Is this a fix somebody would actually apply?
//
// The inferred source proposes a type, and the proposal is the whole value of
// the finding. Measured against a real codebase, the proposals fell into two
// populations. One was names: `ColorTheme`, `ServiceUrls`, `string`. The
// other was noise: a whole function signature inlined, a tuple of tuples, an
// object type spelled out, `any[]`, and in one case the declared type
// repeated back unchanged. The first population is a one-line edit. The
// second is a diagnostic nobody can act on, and shipping it is how a linter
// gets switched off.
//
// So an inferred finding must name a type, and that name must differ from
// what is written now. `any` and `unknown` never qualify: neither is a
// narrowing.
const PRIMITIVE = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "Date",
]);

const NAME_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^<>]*>)?(?:\[\])?$/;

export function isApplicableSuggestion(suggestedRaw, declaredText) {
  if (!suggestedRaw) return false;
  // `readonly T[]` is a name with a modifier in front, not a structural type.
  const suggested = suggestedRaw.replace(/^readonly\s+/, "");
  // Generic ARGUMENTS may mention `any`: `Record<string, unknown>` is a real
  // narrowing of `Record<string, unknown> | null`, and ag-Grid's own default
  // puts `any` inside `ColDef<TData, any>`. What disqualifies a suggestion is
  // being any/unknown/never ITSELF.
  const outer = suggested.replace(/<[^<>]*>/g, "");
  if (/\b(?:any|unknown|never)\b/.test(outer)) return false;
  if (declaredText && declaredText.includes(suggested)) {
    // The declaration already says this. Either nothing was widened, or the
    // widening is somewhere the suggestion cannot express.
    const stripped = declaredText
      .replace(/\s*\|\s*(?:null|undefined)\b/g, "")
      .replace(/\?$/, "")
      .trim();
    if (stripped === suggested.trim()) return true;
  }
  return PRIMITIVE.has(suggested) || NAME_RE.test(suggested);
}

// `typeToString` drops modifiers the declaration carried. A `readonly
// string[]` fed by a `string[]` is still a real finding - the `?` is dead -
// but a suggestion that quietly deletes `readonly` widens the very thing it
// claims to narrow.
export function alignSuggestion(suggested, declaredText) {
  if (!suggested || !declaredText) return suggested;
  if (/\breadonly\b/.test(declaredText) && !/\breadonly\b/.test(suggested)) {
    return `readonly ${suggested}`;
  }
  return suggested;
}

// For an inferred non-null guarantee, the edit is "delete the nullish part",
// and the type to keep is the one the author already wrote.
//
// Deriving the suggestion from the SOURCE type instead proposed swapping one
// name for another whenever the two were structurally identical: a field
// declared `TemplateWithExamples | null | undefined` was told to become
// `Template`. Structurally correct, and a change nobody asked for. What the
// finding is about is the `| null | undefined`, so that is all it should
// propose removing.
export function narrowedDeclaration(declaredText) {
  if (!declaredText) return null;
  const colon = declaredText.indexOf(": ");
  if (colon < 0) return null;
  const written = declaredText
    .slice(colon + 2)
    .replace(/\s*\|\s*(?:null|undefined)\b/g, "")
    .replace(/^\((.*)\)$/, "$1")
    .trim();
  return written.length > 0 ? written : null;
}

// narrowing-loss: the constraint model.
//
// This file is the OWNER of what "narrow" means and of every
// always-true / always-false decision the linter makes. It is pure — no
// TypeScript compiler, no filesystem — so the decision table is unit
// testable in isolation. See tools/narrowing-loss/README.md.
//
// The linter only exists for constraints TypeScript CANNOT represent.
// Where the type system already knows a check is redundant,
// `@typescript-eslint/no-unnecessary-condition` (already "error" in
// eslint.config.js) is the answer and this tool must stay silent — two
// diagnostics for one line is worse than one.

// ---------------------------------------------------------------------------
// Numeric intervals
// ---------------------------------------------------------------------------

// A numeric constraint is an interval over the reals with optionally
// exclusive ends. `lo: 0, loExclusive: true` is "must be > 0".
export function interval(
  lo,
  hi,
  { loExclusive = false, hiExclusive = false } = {},
) {
  return { lo, hi, loExclusive, hiExclusive };
}

const UNBOUNDED = interval(-Infinity, Infinity);

// Is every value of `iv` strictly greater than `k`?
function alwaysGt(iv, k) {
  if (iv.lo > k) return true;
  return iv.lo === k && iv.loExclusive;
}

// Is every value of `iv` less than or equal to `k`?
function alwaysLe(iv, k) {
  return iv.hi <= k;
}

// Is every value of `iv` strictly less than `k`?
function alwaysLt(iv, k) {
  if (iv.hi < k) return true;
  return iv.hi === k && iv.hiExclusive;
}

// Is every value of `iv` greater than or equal to `k`?
function alwaysGe(iv, k) {
  return iv.lo >= k;
}

// Can `iv` contain the exact value `k`?
function canEqual(iv, k) {
  if (k < iv.lo || k > iv.hi) return false;
  if (k === iv.lo && iv.loExclusive) return false;
  if (k === iv.hi && iv.hiExclusive) return false;
  return true;
}

// Decide `value OP literal` where `value` ranges over `iv`.
// Returns "always-true", "always-false", or "undecided".
export function decideNumericComparison(iv, op, k) {
  if (!Number.isFinite(k)) return "undecided";
  switch (op) {
    case ">":
      if (alwaysGt(iv, k)) return "always-true";
      if (alwaysLe(iv, k)) return "always-false";
      return "undecided";
    case ">=":
      if (alwaysGe(iv, k)) return "always-true";
      if (alwaysLt(iv, k)) return "always-false";
      return "undecided";
    case "<":
      if (alwaysLt(iv, k)) return "always-true";
      if (alwaysGe(iv, k)) return "always-false";
      return "undecided";
    case "<=":
      if (alwaysLe(iv, k)) return "always-true";
      if (alwaysGt(iv, k)) return "always-false";
      return "undecided";
    case "===":
    case "==":
      if (!canEqual(iv, k)) return "always-false";
      // A single point interval is the only always-true equality.
      if (iv.lo === iv.hi && iv.lo === k) return "always-true";
      return "undecided";
    case "!==":
    case "!=":
      if (!canEqual(iv, k)) return "always-true";
      if (iv.lo === iv.hi && iv.lo === k) return "always-false";
      return "undecided";
    default:
      return "undecided";
  }
}

// `x OP k` written the other way round — `0 < amount` rather than
// `amount > 0`. Mirrors the operator so the caller can normalise.
export function flipOperator(op) {
  switch (op) {
    case ">":
      return "<";
    case ">=":
      return "<=";
    case "<":
      return ">";
    case "<=":
      return ">=";
    default:
      return op;
  }
}

// ---------------------------------------------------------------------------
// Reading constraints out of generated-client JSDoc
// ---------------------------------------------------------------------------

// The OpenAPI generator drops schema constraints into the description text
// rather than the TypeScript type, so the doc comment is the only place the
// narrowness survives. Each pattern below was taken from an actual
// generated client doc string; keep this list evidence-driven — a
// speculative pattern that never fires is dead weight, and a loose one
// (matching prose about some OTHER field) produces false "dead" verdicts.
const NUMERIC_DOC_PATTERNS = [
  {
    id: "positive",
    // "Amount in minor units (must be > 0)."
    // "Must be greater than zero unless the `zero_amount` directive ..."
    re: /\b(?:must be|is)\s*(?:>|greater than)\s*(?:0\b|zero\b)/i,
    interval: () => interval(0, Infinity, { loExclusive: true }),
    why: "the contract guarantees a strictly positive value",
  },
  {
    id: "non-negative",
    // "Counts are non-negative." Requires a copula so that prose merely
    // MENTIONING non-negativity ("non-negative rows are ignored") cannot
    // masquerade as a guarantee about this field.
    re: /\b(?:is|are|will be)\s+(?:always\s+)?non-?negative\b|\bnon-?negative\s+(?:integer|count|number|value)\b/i,
    interval: () => interval(0, Infinity),
    why: "the contract guarantees a non-negative value",
  },
  {
    id: "range",
    // "Site identifier (1-31, per REQ-004)"
    re: /\((\d+)\s*-\s*(\d+)\s*(?:,|\))/,
    interval: (m) => interval(Number(m[1]), Number(m[2])),
    why: "the contract pins the value to a closed range",
  },
  {
    id: "range-between",
    // "between 1 and 31"
    re: /\bbetween\s+(\d+)\s+and\s+(\d+)\b/i,
    interval: (m) => interval(Number(m[1]), Number(m[2])),
    why: "the contract pins the value to a closed range",
  },
];

// A doc sentence that states a guarantee about the field's own value, as
// opposed to prose that merely MENTIONS a number. Anything matching a
// hedge is discarded: a conditional guarantee is not a guarantee.
const HEDGE_RE =
  /\b(?:unless|except|may be|might be|can be|otherwise|if\s+the\b|when\s+the\b|when\s+present\b|if\s+present\b|omitted|absent|optional)\b/i;

// Non-empty collection guarantees. These must PREDICATE non-emptiness of
// the documented field — "the array is non-empty" — not merely mention it.
// `UnmatchedEvent.missing_exports` documents "Non-empty means the event is
// excluded from matching", which says what a non-empty value would imply and
// guarantees nothing; a bare /non-empty/ test read that as a guarantee and
// called a correct `.length > 0` check dead.
const NON_EMPTY_GUARANTEES = [
  /\b(?:is|are)\s+(?:always\s+)?non-?empty\b/i,
  /\bnever\s+empty\b/i,
  /\bat least one\s+is required\b/i,
  /\(at least one\)/i,
  /\bcontains? at least one\b/i,
];

// "Non-empty means …", "non-empty indicates …" — the phrase is the subject
// of a definition, not a claim about the value in hand.
const NON_EMPTY_DEFINITION_RE =
  /\bnon-?empty\b[^.;]{0,20}\b(?:means|implies|indicates|signals)\b/i;

// Extract the constraint a doc comment states about the field it documents.
// Returns null when the doc says nothing decidable.
export function constraintFromDoc(doc, { isArray = false } = {}) {
  if (typeof doc !== "string" || doc.length === 0) return null;

  // Sentence-level so a hedge in one clause cannot void a guarantee stated
  // in another, and prose about a different field cannot lend its numbers.
  const sentences = doc.split(/(?<=[.;])\s+/);

  for (const sentence of sentences) {
    if (HEDGE_RE.test(sentence)) continue;

    if (
      isArray &&
      !NON_EMPTY_DEFINITION_RE.test(sentence) &&
      NON_EMPTY_GUARANTEES.some((re) => re.test(sentence))
    ) {
      return {
        kind: "non-empty-array",
        interval: interval(1, Infinity),
        why: "the contract guarantees a non-empty collection",
        source: sentence.trim(),
      };
    }
    if (isArray) continue;

    for (const pattern of NUMERIC_DOC_PATTERNS) {
      const m = pattern.re.exec(sentence);
      if (m) {
        return {
          kind: pattern.id,
          interval: pattern.interval(m),
          why: pattern.why,
          source: sentence.trim(),
        };
      }
    }
  }
  return null;
}

export { UNBOUNDED };

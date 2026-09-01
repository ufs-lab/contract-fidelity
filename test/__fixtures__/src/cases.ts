import type { Movement } from "../clients/@acme/fake-client/api";

// --- should FIRE -----------------------------------------------------------

// `must be > 0` widened to a bare `number`, then defended.
function formatAmount(amount: number): string {
  if (amount > 0) return `${amount}`;
  return "-";
}

// `non-negative` widened, then compared against a bound it can never cross.
function formatStaged(staged: number): string {
  return staged >= 0 ? `${staged}` : "-";
}

// Enum union widened to `string`, leaving an unreachable default.
function scopeLabel(scope: string): string {
  switch (scope) {
    case "HOUSE":
      return "House";
    case "CLIENT":
      return "Client";
    case "GROUP":
      return "Group";
    default:
      return "Unknown";
  }
}

// Required non-null widened to nullable, then given a fallback.
function tagList(tags: string[] | null): string {
  return (tags ?? []).join(", ");
}

// Documented non-empty array, emptiness-tested anyway.
function firstLeg(legs: string[]): string {
  if (legs.length > 0) return legs[0] ?? "";
  return "";
}

export function fires(m: Movement): string[] {
  return [
    formatAmount(m.amount),
    formatStaged(m.staged),
    scopeLabel(m.scope),
    tagList(m.tags),
    firstLeg(m.legs),
  ];
}

// --- should NOT fire -------------------------------------------------------

// `count > 0` on a non-negative count is a real presence test: 0 is legal.
function hasStaged(staged: number): boolean {
  return staged > 0;
}

// The signature keeps the contract type, so nothing was widened.
function scopeLabelTyped(scope: "HOUSE" | "CLIENT" | "GROUP"): string {
  switch (scope) {
    case "HOUSE":
      return "House";
    default:
      return "Other";
  }
}

// `!label` is a FALSY test, and "" is both falsy and a legal value for a
// contract-required string.
function labelOrDash(label: string): string {
  return !label ? "-" : label;
}

// "Non-empty means ..." defines what non-emptiness implies; it does not
// promise the array is non-empty.
function hasMissing(missing: string[]): boolean {
  return missing.length > 0;
}

export function quiet(m: Movement): unknown[] {
  return [
    hasStaged(m.staged),
    scopeLabelTyped(m.scope),
    labelOrDash(m.label),
    hasMissing(m.missing_exports),
  ];
}

// --- a guard sitting directly on a contract read ---------------------------

// Nothing was widened here: the check re-derives at runtime what the contract
// already states. The codebase trusts the contract, so this is a finding like
// any other rather than a defensible assertion at the edge.
export function boundaryCheck(m: Movement): string {
  return typeof m.staged === "number" ? "counted" : "unknown";
}

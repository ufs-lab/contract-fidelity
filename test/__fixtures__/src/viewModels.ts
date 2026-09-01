import type { Movement } from "../clients/@acme/fake-client/api";

// A view model that widens two contract-guaranteed fields.
interface RowVM {
  label: string | undefined;
  scope: string;
}

export function buildRow(m: Movement): RowVM {
  return { label: m.label, scope: m.scope };
}

// Every write to RowVM.label comes from a contract-required field, so this
// guard is dead.
export function renderLabel(row: RowVM): string {
  return row.label ?? "-";
}

// Every write to RowVM.scope is a contract enum member, so "" is impossible.
export function hasScope(row: RowVM): boolean {
  return row.scope !== "";
}

// --- a field with an unaccounted write must stay silent -------------------

interface LooseVM {
  label: string | undefined;
}

export function buildLoose(m: Movement): LooseVM {
  return { label: m.label };
}

// A second writer supplies something the contract says nothing about, so the
// `?? "-"` branch below is genuinely reachable.
export function buildLooseFromAnywhere(value: string | undefined): LooseVM {
  return { label: value };
}

export function renderLoose(row: LooseVM): string {
  return row.label ?? "-";
}

// --- a cast-built object is still a write ---------------------------------

interface CastVM {
  label: string | undefined;
}

export function buildCast(m: Movement): CastVM {
  return { label: m.label } as CastVM;
}

export function buildCastFromAnywhere(value: string | undefined): CastVM {
  return { label: value } as CastVM;
}

export function renderCast(row: CastVM): string {
  return row.label ?? "-";
}

// --- validators are not widenings -----------------------------------------

// A type predicate exists to check; its checks are the point.
function isText(value: unknown): value is string {
  return typeof value === "string";
}

// An assertion helper that throws is deliberately taking `unknown`.
function requireText(value: unknown): string {
  if (typeof value === "string") return value;
  throw new Error("not text");
}

// But a function that merely widens and returns a default is still a
// widening, even when the parameter mentions `unknown`.
function textOrEmpty(value: unknown[] | undefined): number {
  if (!value || !Array.isArray(value)) return 0;
  return value.length;
}

export function validators(m: Movement): unknown[] {
  return [isText(m.label), requireText(m.label), textOrEmpty(m.tags)];
}

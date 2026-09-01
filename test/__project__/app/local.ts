// No contract anywhere in this file. Every finding here comes from the
// checker's own types.

// A NAMED union. An anonymous one is not a narrowing target: proposing
// `"OPEN" | "CLOSED"` as an annotation is noise, proposing `Status` is an
// edit.
export type Status = "OPEN" | "CLOSED";

export interface Row {
  id: string;
  status: Status;
}

// A view model that widens both fields of a purely local type.
export interface RowVM {
  id: string | undefined;
  status: string;
}

export function toVM(row: Row): RowVM {
  return { id: row.id, status: row.status };
}

// A cast that invents an absent case.
export function idOf(row: Row): string | undefined {
  return row.id as string | undefined;
}

// The double cast, where the laundering hides behind its own mechanism.
export function statusOf(row: Row): string {
  return row.status as unknown as string;
}

// A `let` whose wider type is doing real work. Never a finding.
export function maybe(row: Row): string | undefined {
  let held: string | undefined = row.id;
  held = undefined;
  return held;
}

// A parameter every caller feeds a present value, declared as if it might be
// absent. No guard is written on it yet, and that is the point: the widening
// is what makes the guard look necessary later.
function describeId(id: string | undefined): string {
  return `id=${String(id)}`;
}

export function useIds(a: Row, b: Row): string {
  return `${describeId(a.id)} ${describeId(b.id)}`;
}

// One caller passes something genuinely absent, so the wider type is real.
function describeMaybe(id: string | undefined): string {
  return `id=${String(id)}`;
}

export function useMaybe(row: Row, missing: string | undefined): string {
  return `${describeMaybe(row.id)} ${describeMaybe(missing)}`;
}

// Exported, so only provable under closedWorld.
export function describePublic(id: string | undefined): string {
  return `id=${String(id)}`;
}

export function usePublic(row: Row): string {
  return describePublic(row.id);
}

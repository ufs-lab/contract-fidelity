import type { Row } from "./local";

// (a) a null literal is a write of null; the field must not be proven.
export interface Slot {
  held: Row | null;
}
export function fill(row: Row): Slot {
  return { held: row };
}
export function empty(): Slot {
  return { held: null };
}

// (b) omission through a mapped type. The caller omits `mode` via Partial<>,
// so `mode` is not always supplied.
export interface Opts {
  mode?: string;
  scale: number;
}
export function withOpts(o: Opts): number {
  return o.mode === undefined ? o.scale : o.scale * 2;
}
export function viaPartial(p: Partial<Opts>): number {
  return withOpts({ scale: 1, ...p });
}
export function omitsViaPartial(): number {
  return viaPartial({ scale: 2 });
}
export function suppliesMode(row: Row): number {
  return withOpts({ mode: row.id, scale: 1 });
}

// (c) omission through a generic instantiation.
export interface Box<T> {
  value: T;
  label?: string;
}
export function boxed(row: Row): Box<Row> {
  return { value: row, label: row.id };
}
export function unlabelled(row: Row): Box<Row> {
  return { value: row };
}

// (d) a shape that is deserialised: the writes the census sees are not the
// only source of values.
export interface Stored {
  name?: string;
}
export function save(row: Row): string {
  const s: Stored = { name: row.id };
  return JSON.stringify(s);
}
export function load(raw: string): string {
  const s = JSON.parse(raw) as Stored;
  return s.name ?? "none";
}

// (e) a discriminated union arm. `error` is Error on one arm and null on the
// other; narrowing one arm is meaningless.
export type Result = { ok: true; error: null } | { ok: false; error: Error };
export function fail(e: Error): Result {
  return { ok: false, error: e };
}
export function succeed(): Result {
  return { ok: true, error: null };
}

// (f) a cast onto an INLINE shape. `examples` has no named type to exclude,
// but a value cast into it arrived from outside the census all the same, so
// the Array.isArray on it is a real check.
export function inlineCast(raw: Record<string, unknown>): number {
  const shaped = structuredClone(raw) as Record<string, unknown> & {
    examples?: unknown;
  };
  const list = Array.isArray(shaped.examples) ? shaped.examples : [];
  shaped.examples = list.map((e) => e);
  return list.length;
}

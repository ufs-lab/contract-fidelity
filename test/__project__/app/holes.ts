// Census holes a real codebase exposed, outside JSX.

import type { Row } from "./local";

// (H3) A spread writes the fields of the TARGET, not of the source.
//
// The census used to disqualify the SOURCE type's fields, which is the one
// set of fields a spread does not write. `SpreadTarget.entity` was proven
// from the literal below while `{ ...src }` was free to put null there.
export interface SpreadSource {
  entity: string | null;
}

export interface SpreadTarget {
  entity: string | null;
}

export function targetFromLiteral(row: Row): SpreadTarget {
  return { entity: row.id };
}

export function targetFromSpread(src: SpreadSource): SpreadTarget {
  return { ...src };
}

// A property written AFTER the spread supplies the field whatever the source
// holds, so the spread does not disqualify it.
export interface OverrideTarget {
  entity: string | null;
}

export function overrideAfterSpread(
  src: SpreadSource,
  row: Row,
): OverrideTarget {
  return { ...src, entity: row.id };
}

// (H4) `o["f"] = e` is a write, and it can write anything.
export interface Settings {
  theme: string | null;
}

export function defaultSettings(row: Row): Settings {
  return { theme: row.id };
}

export function clearTheme(s: Settings): void {
  s["theme"] = null;
}

// (H4) A computed key names no field, so every field of the type is unproven.
export interface Dynamic {
  slot: string | null;
}

export function defaultDynamic(row: Row): Dynamic {
  return { slot: row.id };
}

export function setByKey(d: Dynamic, key: "slot", value: string | null): void {
  d[key] = value;
}

// (H4) `delete` is a write of absent.
export interface Removable {
  tag?: string;
}

export function defaultRemovable(row: Row): Removable {
  return { tag: row.id };
}

export function dropTag(r: Removable): void {
  delete r.tag;
}

// (H4) A compound assignment writes a value that is not the right side alone.
export interface Notes {
  note: string | null;
}

export function defaultNotes(row: Row): Notes {
  return { note: row.id };
}

export function fillNote(n: Notes, fallback: string): void {
  n.note ??= fallback;
}

// (H4) `Object.assign` writes every field of the target from a value this
// census cannot read field by field.
export interface Merged {
  title: string | null;
}

export function defaultMerged(row: Row): Merged {
  return { title: row.id };
}

export function mergeInto(m: Merged, extra: Partial<Merged>): void {
  Object.assign(m, extra);
}

// (H5) A function handed to somebody else as a value is called with arguments
// no call expression in this program names.
function addScope(scope: string | undefined): string {
  return scope ?? "none";
}

export function scopesOf(row: Row): string[] {
  return [addScope(row.id), ...["a"].map(addScope)];
}

// The control: the same shape, called directly everywhere, stays provable.
function describeScope(scope: string | undefined): string {
  return scope ?? "none";
}

export function describedScopes(row: Row): string[] {
  return [describeScope(row.id), describeScope(row.id)];
}

// (H6) A parameter whose only caller is a test file proves nothing about
// production. See holes.test.ts.
export function seededByTestCaller(id: string | undefined): string {
  return `id=${String(id)}`;
}

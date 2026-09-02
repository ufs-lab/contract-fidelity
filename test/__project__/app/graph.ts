// The whole-program fixed point, on the shapes that need more than one hop.
// Each case names the rule it exercises, and graph.test.mjs shows which
// revert of that rule flips it.

import type { Row } from "./local";

// (1) A parameter fed only by another parameter, which is itself fed only by
// present values. A one-hop census reads `args` at the dispatch site through
// its declared type, `Record<string, unknown> | null`, and stops there. The
// graph carries the dispatcher's proof into every handler in the same run.
function handleOne(args: Record<string, unknown> | null): number {
  return args === null ? 0 : Object.keys(args).length;
}

function handleTwo(args: Record<string, unknown> | null): number {
  return args === null ? 0 : Object.keys(args).length * 2;
}

function dispatch(name: string, args: Record<string, unknown> | null): number {
  return name === "one" ? handleOne(args) : handleTwo(args);
}

export function bridge(args: Record<string, unknown>, row: Row): number {
  return dispatch(row.id, args);
}

// (2) A return slot feeds a `const`, and the `const` feeds a parameter.
function load(row: Row): string | undefined {
  return row.id;
}

function use(id: string | undefined): string {
  return id ?? "";
}

export function throughReturn(row: Row): string {
  const id = load(row);
  return use(id);
}

// (3) The site-identity rule. `Range.start` is always written present, but
// `range?.start` is not a plain read of it: the checker's type at the site
// is `string | undefined`, and that is what reaches `toInput`.
export interface Range {
  start: string;
}

export function makeRange(row: Row): Range {
  return { start: row.id };
}

function toInput(date: string | undefined): string {
  return date ?? "";
}

export function useRange(range: Range | undefined): string {
  return toInput(range?.start);
}

// (4) An exhausted switch narrows `mode` to `never`. The declaration holds
// the whole union; the reference is unreachable, and `value: never` is not a
// widening of it.
export type Mode = "a" | "b";

function modeOf(row: Row): Mode {
  return row.status === "OPEN" ? "a" : "b";
}

function assertUnreachable(value: never): never {
  throw new Error(String(value));
}

function label(mode: Mode): string {
  switch (mode) {
    case "a":
      return "A";
    case "b":
      return "B";
    default:
      return assertUnreachable(mode);
  }
}

export function useLabel(rows: Row[]): string[] {
  return rows.map((row) => label(modeOf(row)));
}

// (5) An unreachable edge contributes nothing. `describe` is called twice
// with present strings and once from a branch the checker has exhausted. The
// exhausted call must not stop the proof.
function describe(id: string | null): string {
  return id ?? "none";
}

export function exhaustive(row: Row): string {
  switch (row.status) {
    case "OPEN":
      return describe(row.id);
    case "CLOSED":
      return describe(row.id);
    default:
      return describe(row.status);
  }
}

// (6) Recursion. The self edge starts at BOTTOM, the external caller says
// `Row`, and the node converges to `Row`. A solver that started a recursive
// parameter at "unproven" would never prove it.
function walk(node: Row | undefined, depth: number): number {
  if (depth > 3) return depth;
  return walk(node, depth + 1);
}

export function useWalk(row: Row): number {
  return walk(row, 0);
}

function ping(node: Row | undefined, depth: number): number {
  return depth > 3 ? depth : pong(node, depth + 1);
}

function pong(node: Row | undefined, depth: number): number {
  return depth > 3 ? depth : ping(node, depth + 1);
}

export function usePing(row: Row): number {
  return ping(row, 0);
}

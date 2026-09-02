// The whole-program fixed point, end to end over test/__project__/app/graph.ts.
//
// Each test names the rule it pins and the revert that flips it. The rules
// are the ones that let a guarantee cross any number of hops without
// laundering an unknown edge into the nodes downstream.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "contract-fidelity.mjs");
const PROJECT = join(HERE, "__project__");

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: PROJECT,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return `${res.stdout}${res.stderr}`;
}

const rows = JSON.parse(run(["widening", "--json"])).filter(
  (r) => r.file === "app/graph.ts",
);
const parameter = (name) =>
  rows.find((r) => r.declared.startsWith(`parameter: ${name}(`));
const seen = () => rows.map((r) => r.declared).join("\n");

test("a proven parameter proves the parameter it is passed on to, in one run", () => {
  // The dispatcher shape. A one-hop census reports `dispatch` and stops;
  // the handlers surface only after `dispatch` has been narrowed and the
  // tool re-run. Revert: drop the source node from the edge (rule 2 and 4
  // in graph.mjs), and only `dispatch` is reported.
  for (const name of ["dispatch", "handleOne", "handleTwo"]) {
    const hit = parameter(name);
    assert.ok(hit, `expected ${name}(args) to be reported; saw:\n${seen()}`);
    assert.equal(hit.suggestedType, "Record<string, unknown>");
    assert.equal(hit.origin, "inferred");
  }
});

test("a return slot proves the const it fills, and the const proves the parameter", () => {
  // `const id = load(row); use(id)`. The `const` node replaces the alias
  // chase, and a return slot is a source like any other.
  assert.ok(
    rows.some((r) => r.declared === "return type: load(): string | undefined"),
    `expected load() to be reported; saw:\n${seen()}`,
  );
  const hit = parameter("use");
  assert.ok(hit, `expected use(id) to be reported; saw:\n${seen()}`);
  assert.equal(hit.suggestedType, "string");
});

test("a reference that is not a plain read of the declaration proves nothing", () => {
  // `Range.start` is always present; `range?.start` is not. The checker's
  // type at the reference is wider than the declaration's, so the
  // declaration's proof must not be used. Revert: skip the mutual
  // assignability test in makeEdge, and `toInput` is reported.
  assert.equal(
    parameter("toInput"),
    undefined,
    `toInput(date) is fed by an optional chain; saw:\n${seen()}`,
  );
  // An exhausted switch narrows `mode` to `never`. Neither the identity rule
  // nor the never rule lets the union reach `value: never`.
  assert.equal(
    parameter("assertUnreachable"),
    undefined,
    `assertUnreachable(value: never) is unreachable; saw:\n${seen()}`,
  );
});

test("an unreachable edge contributes nothing", () => {
  // `describe(row.status)` sits in an exhausted `default:`. Its type there
  // is `never`, and the edge is BOTTOM, not TOP: it must not stop the other
  // two callers from proving the parameter. Revert: return TOP for a never
  // edge in evaluate, and `describe` goes silent.
  const hit = parameter("describe");
  assert.ok(hit, `expected describe(id) to be reported; saw:\n${seen()}`);
  assert.equal(hit.suggestedType, "string");
});

test("a recursive parameter converges to its callers' proof", () => {
  // The self edge of `walk` and the mutual edges of `ping` and `pong` start
  // at BOTTOM and rise with the external caller. Revert: start a node at
  // TOP in makeNode, and none of the three is reported.
  for (const name of ["walk", "ping", "pong"]) {
    const hit = parameter(name);
    assert.ok(hit, `expected ${name}(node) to be reported; saw:\n${seen()}`);
    assert.equal(hit.suggestedType, "Row");
  }
});

test("the fixture compiles", () => {
  // The scanners read the checker's types. A fixture that does not compile
  // would make every assertion above vacuous.
  const res = spawnSync(
    process.execPath,
    [join(HERE, "..", "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "."],
    { cwd: PROJECT, encoding: "utf8" },
  );
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
});

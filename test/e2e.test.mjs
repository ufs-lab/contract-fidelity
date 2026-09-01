// End-to-end: the path a user actually hits.
//
// Every other test calls `analyzeProgram` directly on a fixture tree that
// happens to contain `src/`. That skips bin -> config -> createProgram ->
// ratchet entirely, and it hid a real defect: three scan-scope tests in
// dead-code.mjs and one in fields.mjs compared against a hardcoded
// `src/`, so a project configured with any other `scanRoots` was scanned for
// nothing and told it was clean. A vacuous pass is worse than a wrong answer,
// because nobody investigates a green check.
//
// The project under test/__project__ therefore keeps its code in `app/`.
// If either scanner regains a hardcoded `src`, these tests fail.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "contract-fidelity.mjs");
const PROJECT = join(HERE, "__project__");

// A findings run exits non-zero by design, and the scanners print the count
// on stdout and the detail on stderr, so both streams are needed.
function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: PROJECT,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return `${res.stdout}${res.stderr}`;
}

test("dead-code honours a scanRoots other than src", () => {
  const out = run(["dead-code", "--list"]);
  assert.match(out, /app\/orders\.ts/);
  assert.match(out, /`m\.amount > 0` is always true/);
  assert.doesNotMatch(
    out,
    /clean \(0 violations\)/,
    "a project with code outside src must not report a vacuous pass",
  );
});

test("widening honours a scanRoots other than src", () => {
  const out = run(["widening", "--list"]);
  assert.match(out, /app\/orders\.ts/);
  assert.match(out, /the contract declares the source field required/);
  assert.doesNotMatch(out, /clean \(0 violations\)/);
});

// A finding a model can apply, rather than one it has to interpret.
test("widening names the type to narrow to", () => {
  const out = run(["widening", "--list"]);
  // The alias, not its members spelled out: `Scope`, not `"HOUSE" | ...`.
  assert.match(out, /narrow to: Scope/);
  assert.match(out, /narrow to: string/);

  const rows = JSON.parse(run(["widening", "--json"]));
  const scope = rows.find((r) => r.contractField === "scope");
  assert.equal(scope.suggestedType, "Scope");
  assert.equal(scope.constraintKind, "enum-member");
});

// openapi-generator emits models as interfaces (typescript-axios) or as
// classes (typescript-node). The audit walked interfaces only, so on a
// class-emitting SDK it printed nothing and read as "no guarantees here".
test("the contracts audit sees class models, not just interfaces", () => {
  const out = run(["contracts"]);
  assert.match(out, /positive\s+Movement\.amount/);
  assert.match(out, /non-negative\s+MovementModel\.staged/);
  assert.doesNotMatch(
    out,
    /describe/,
    "a method is not a data field and carries no guarantee",
  );
});

test("the CLI rejects an unknown command", () => {
  const out = run(["nonsense"]);
  assert.match(out, /unknown command nonsense/);
});

// The schema work queue. Not a gate: a ranked list of what to fix upstream.
test("optional-fields ranks the guards a schema forces", () => {
  const out = run(["optional-fields"]);
  assert.match(out, /Movement\.note/);
  assert.match(out, /\?\? x1/);
  // A required field's guards belong to dead-code, not here.
  assert.doesNotMatch(out, /Movement\.amount/);
});

test("optional-fields reports per-site detail as JSON", () => {
  const rows = JSON.parse(run(["optional-fields", "--json"]));
  const note = rows.find((r) => r.field === "Movement.note");
  assert.equal(note.guards, 2);
  assert.equal(note.sites.length, 2);
  assert.ok(note.sites.every((s) => s.file === "app/orders.ts"));
});

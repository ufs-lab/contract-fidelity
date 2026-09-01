// The ratchet, exercised through the real CLI against a real project.
//
// The baseline used to record a count per file. That passes the one trade
// this tool exists to catch: fix a finding and add another in the same file,
// and the count does not move. These tests pin the set semantics, and the
// refusal to read a version 1 baseline as "no findings".

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "contract-fidelity.mjs");
const PROJECT = join(HERE, "__project__");
const BASELINE_DIR = join(PROJECT, ".contract-fidelity");
const BASELINE = join(BASELINE_DIR, "dead-code-baseline.json");
const SOURCE = join(PROJECT, "app", "orders.ts");

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: PROJECT,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

function withCleanState(body) {
  const original = readFileSync(SOURCE, "utf8");
  rmSync(BASELINE_DIR, { recursive: true, force: true });
  try {
    body();
  } finally {
    writeFileSync(SOURCE, original, "utf8");
    rmSync(BASELINE_DIR, { recursive: true, force: true });
  }
}

test("an unbaselined finding fails, and a seeded one passes", () => {
  withCleanState(() => {
    const first = run(["dead-code"]);
    assert.equal(first.code, 1, "a finding with no baseline must fail");
    assert.match(first.out, /1 new finding\(s\)/);

    const seed = run(["dead-code", "--update-baseline", "--force"]);
    assert.equal(seed.code, 0);

    const after = run(["dead-code"]);
    assert.equal(after.code, 0, "the seeded finding must not fail again");
    assert.match(after.out, /clean \(1 baselined finding\(s\) remain\)/);
  });
});

test("swapping one finding for another in the same file fails", () => {
  // The whole reason the baseline holds a set. A per-file count is unchanged
  // by this edit, so the old ratchet passed it.
  withCleanState(() => {
    run(["dead-code", "--update-baseline", "--force"]);

    const before = readFileSync(SOURCE, "utf8");
    assert.ok(before.includes("if (m.amount > 0) {"));
    writeFileSync(
      SOURCE,
      before.replace("if (m.amount > 0) {", "if (m.amount !== 0) {"),
      "utf8",
    );

    const swapped = run(["dead-code"]);
    assert.equal(swapped.code, 1, "a different finding is a new finding");
    assert.match(swapped.out, /new: app\/orders\.ts :: m\.amount !== 0/);
  });
});

test("a version 1 baseline is refused, not read as empty", () => {
  // Reading `{ "file": 1 }` as "no findings" would silence the gate on the
  // next run: the exact vacuous pass this tool exists to prevent.
  withCleanState(() => {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(BASELINE, '{"app/orders.ts": 1}\n', "utf8");

    const res = run(["dead-code"]);
    assert.equal(res.code, 1);
    assert.match(res.out, /is not a version 2 baseline/);
    assert.doesNotMatch(res.out, /clean/);
  });
});

test("--update-baseline refuses to add a finding without --force", () => {
  withCleanState(() => {
    const res = run(["dead-code", "--update-baseline"]);
    assert.equal(res.code, 1);
    assert.match(res.out, /refusing to add 1 finding\(s\)/);
  });
});

test("a fixed finding is reported as an improvement, not a failure", () => {
  withCleanState(() => {
    run(["dead-code", "--update-baseline", "--force"]);

    const before = readFileSync(SOURCE, "utf8");
    const guarded = [
      "  if (m.amount > 0) {",
      "    return `${m.label}: ${String(m.amount)}`;",
      "  }",
      '  return "empty";',
    ].join("\n");
    // Assert the edit lands. A replace that silently matches nothing would
    // leave the finding in place and make this test pass for the wrong
    // reason.
    assert.ok(before.includes(guarded), "fixture drifted from the test");
    writeFileSync(
      SOURCE,
      before.replace(guarded, "  return `${m.label}: ${String(m.amount)}`;"),
      "utf8",
    );

    const res = run(["dead-code"]);
    assert.equal(res.code, 0);
    assert.match(res.out, /1 fixed, run/);
  });
});

test("the baseline records findings by name, not by count", () => {
  withCleanState(() => {
    run(["dead-code", "--update-baseline", "--force"]);
    const written = JSON.parse(readFileSync(BASELINE, "utf8"));
    assert.equal(written.version, 2);
    assert.deepEqual(written.findings, {
      "app/orders.ts": ["m.amount > 0 :: Movement.amount :: positive"],
    });
  });
});

test("--json carries the fingerprint so a reader can match the baseline", () => {
  withCleanState(() => {
    const res = run(["dead-code", "--json"]);
    const rows = JSON.parse(res.out);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].fingerprint,
      "m.amount > 0 :: Movement.amount :: positive",
    );
  });
});

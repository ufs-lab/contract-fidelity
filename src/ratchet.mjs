// narrowing-loss: the down-only baseline ratchet.
//
// Shared by both scanners here. The contract is the one the rest of this
// repo's tools use: a per-file count, a failure when a file exceeds its
// baseline (or when an unbaselined file has any violation), and a refusal to
// raise a count without `--force`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

function countsFrom(byFile) {
  const counts = {};
  for (const [file, list] of byFile) counts[file] = list.length;
  return counts;
}

async function readBaseline(baselineFile) {
  try {
    return JSON.parse(await readFile(baselineFile, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeBaseline(baselineFile, counts) {
  // The baseline lives in the consumer's tree, in a directory that may not
  // exist on a first run.
  await mkdir(dirname(baselineFile), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(baselineFile, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

// `collect` returns a Map<file, violation[]>; `print` renders a subset of it.
export function createRatchet({
  id,
  repoRoot,
  baselineFile,
  collect,
  print,
  failureHeadline,
  fixHint,
}) {
  // `baselineFile` is a thunk: the path depends on config, which is not
  // loaded until first use.
  const resolveBaseline = () =>
    typeof baselineFile === "function" ? baselineFile() : baselineFile;

  async function check(options) {
    const byFile = collect(options);
    const counts = countsFrom(byFile);
    const baseline = await readBaseline(resolveBaseline());

    const regressed = [];
    for (const [file, count] of Object.entries(counts)) {
      const base = baseline[file] ?? 0;
      if (count > base) regressed.push({ file, count, base });
    }
    const improved = Object.entries(baseline).filter(
      ([file, base]) => (counts[file] ?? 0) < base,
    );

    if (regressed.length > 0) {
      process.stderr.write(
        `${id}: ${regressed.length} file(s) exceed the baseline — ${failureHeadline}\n\n`,
      );
      print(
        byFile,
        regressed.map((r) => r.file),
      );
      for (const r of regressed) {
        const context =
          r.base === 0 ? "new violating file" : `baseline ${r.base}`;
        process.stderr.write(`  ${r.file}: ${r.count} > ${context}\n`);
      }
      process.stderr.write(
        `\n${fixHint}\nDo NOT raise the baseline. See tools/narrowing-loss/README.md.\n`,
      );
      return 1;
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (improved.length > 0) {
      process.stdout.write(
        `${id}: clean (${total} baselined violation(s) remain; ` +
          `${improved.length} file(s) improved — run \`pnpm run lint:${id}:update-baseline\` to ratchet down)\n`,
      );
    } else {
      process.stdout.write(
        `${id}: clean (${total} baselined violation(s) remain)\n`,
      );
    }
    return 0;
  }

  function list(options) {
    const byFile = collect(options);
    const files = [...byFile.keys()].sort();
    const total = files.reduce((a, f) => a + byFile.get(f).length, 0);
    if (total === 0) {
      process.stdout.write(`${id}: clean (0 violations)\n`);
      return 0;
    }
    process.stdout.write(
      `${id}: ${total} violation(s) across ${files.length} file(s)\n\n`,
    );
    print(byFile, files);
    return 0;
  }

  function json(options) {
    const byFile = collect(options);
    process.stdout.write(
      `${JSON.stringify([...byFile.values()].flat(), null, 2)}\n`,
    );
    return 0;
  }

  async function updateBaseline(force, options) {
    const byFile = collect(options);
    const counts = countsFrom(byFile);
    const old = await readBaseline(resolveBaseline());

    const increases = [];
    for (const [file, count] of Object.entries(counts)) {
      const base = old[file] ?? 0;
      if (count > base) increases.push({ file, count, base });
    }

    if (increases.length > 0 && !force) {
      process.stderr.write(
        `${id}: refusing to raise the baseline (down-only ratchet)\n\n`,
      );
      for (const inc of increases) {
        const context =
          inc.base === 0 ? "not baselined" : `baseline ${inc.base}`;
        process.stderr.write(`  ${inc.file}: ${inc.count} > ${context}\n`);
      }
      process.stderr.write(
        "\nFix the widening, or pass --force for an intentional initial seed.\n",
      );
      return 1;
    }

    await writeBaseline(resolveBaseline(), counts);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    process.stdout.write(
      `${id}: wrote ${relative(repoRoot, resolveBaseline())} (${total} violation(s) across ${Object.keys(counts).length} file(s))\n`,
    );
    return 0;
  }

  return { check, list, json, updateBaseline };
}

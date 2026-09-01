// contract-fidelity: the down-only baseline ratchet.
//
// Shared by both scanners. The baseline records the SET of findings, not a
// count per file.
//
// A count per file passes the trade this tool exists to catch: fix one
// finding in a file, add another in the same file, and the count is
// unchanged. That is precisely the edit a model makes when it is asked to
// clear a lint and has no opinion about which line it clears. The set makes
// "new finding" exact, and lets --update-baseline refuse to ADD a fingerprint
// rather than refuse to raise a number.
//
// A fingerprint deliberately omits the line number. Line numbers churn on
// every edit above them, and a baseline that churns is a baseline nobody
// reads. What identifies a finding is the file, the text of the thing at
// fault, the contract it disagrees with, and the kind of guarantee.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

const FORMAT_VERSION = 2;

// Two identical guards on the same contract in one file are distinct
// findings, and fixing one must count as an improvement rather than as
// nothing. Numbering the repeats keeps them separable without reintroducing
// the line number: the set shrinks by one when one of them goes.
function withOccurrenceSuffixes(entries) {
  const seen = new Map();
  return entries.map((entry) => {
    const n = (seen.get(entry) ?? 0) + 1;
    seen.set(entry, n);
    return n === 1 ? entry : `${entry} #${n}`;
  });
}

// Map<file, finding[]> becomes Map<file, fingerprint[]>, stable across edits.
function entriesFrom(byFile, fingerprintOf) {
  const out = new Map();
  for (const [file, list] of byFile) {
    const ordered = [...list].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    out.set(file, withOccurrenceSuffixes(ordered.map(fingerprintOf)));
  }
  return out;
}

function flatten(entriesByFile) {
  const set = new Set();
  for (const [file, entries] of entriesByFile) {
    for (const entry of entries) set.add(`${file} :: ${entry}`);
  }
  return set;
}

function totalOf(entriesByFile) {
  let n = 0;
  for (const entries of entriesByFile.values()) n += entries.length;
  return n;
}

async function readBaseline(baselineFile) {
  let raw;
  try {
    raw = await readFile(baselineFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw err;
  }
  const parsed = JSON.parse(raw);

  // A version 1 baseline is a bare { file: count } map. To read it as "no
  // findings" would silence the gate on the next run, which is the exact
  // failure this tool exists to prevent. Fail, and say how to migrate.
  if (parsed?.version !== FORMAT_VERSION) {
    throw new Error(
      `${baselineFile} is not a version ${FORMAT_VERSION} baseline. ` +
        "Version 1 held a count per file; this version holds the findings themselves. " +
        "Re-seed it with `--update-baseline --force`, then read the diff: the new file " +
        "names every baselined finding, so anything missing was never really fixed.",
    );
  }
  return new Map(Object.entries(parsed.findings ?? {}));
}

async function writeBaseline(baselineFile, entriesByFile) {
  // The baseline lives in the consumer's tree, in a directory that may not
  // exist on a first run.
  await mkdir(dirname(baselineFile), { recursive: true });
  const findings = {};
  for (const file of [...entriesByFile.keys()].sort((a, b) =>
    a.localeCompare(b),
  )) {
    const entries = entriesByFile.get(file);
    if (entries.length > 0) findings[file] = [...entries].sort();
  }
  const body = { version: FORMAT_VERSION, findings };
  await writeFile(baselineFile, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

// `collect` returns a Map<file, violation[]>; `print` renders a subset of it.
// `fingerprintOf` turns one violation into a stable, line-free identity.
export function createRatchet({
  id,
  // The CLI sub-command this ratchet backs. Every hint printed to a user must
  // name a command they can actually run: the messages here once told them to
  // read a file and run a script that existed only in the repo this tool was
  // extracted from.
  command,
  repoRoot,
  baselineFile,
  collect,
  print,
  fingerprintOf,
  failureHeadline,
  fixHint,
}) {
  // `baselineFile` is a thunk: the path depends on config, which is not
  // loaded until first use.
  const resolveBaseline = () =>
    typeof baselineFile === "function" ? baselineFile() : baselineFile;

  // Findings the baseline does not already carry, grouped by file.
  function newFindings(entriesByFile, baselineByFile) {
    const added = new Map();
    for (const [file, entries] of entriesByFile) {
      const known = new Set(baselineByFile.get(file) ?? []);
      const unknown = entries.filter((entry) => !known.has(entry));
      if (unknown.length > 0) added.set(file, unknown);
    }
    return added;
  }

  async function check(options) {
    const byFile = collect(options);
    const entriesByFile = entriesFrom(byFile, fingerprintOf);
    const baselineByFile = await readBaseline(resolveBaseline());

    const added = newFindings(entriesByFile, baselineByFile);
    const current = flatten(entriesByFile);
    const fixed = [...flatten(baselineByFile)].filter((k) => !current.has(k));

    if (added.size > 0) {
      const count = totalOf(added);
      process.stderr.write(
        `${id}: ${count} new finding(s) in ${added.size} file(s): ${failureHeadline}\n\n`,
      );
      print(byFile, [...added.keys()].sort());
      for (const [file, entries] of added) {
        for (const entry of entries) {
          process.stderr.write(`  new: ${file} :: ${entry}\n`);
        }
      }
      process.stderr.write(
        `\n${fixHint}\nDo NOT add to the baseline: it only ever ratchets down.\n`,
      );
      return 1;
    }

    const total = totalOf(entriesByFile);
    if (fixed.length > 0) {
      process.stdout.write(
        `${id}: clean (${total} baselined finding(s) remain; ` +
          `${fixed.length} fixed, run ` +
          `\`contract-fidelity ${command} --update-baseline\` to ratchet down)\n`,
      );
    } else {
      process.stdout.write(
        `${id}: clean (${total} baselined finding(s) remain)\n`,
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
    const rows = [...byFile.entries()].flatMap(([file, list]) => {
      const entries = entriesFrom(new Map([[file, list]]), fingerprintOf).get(
        file,
      );
      const ordered = [...list].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      return ordered.map((finding, i) => ({
        ...finding,
        fingerprint: entries[i],
      }));
    });
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  async function updateBaseline(force, options) {
    const byFile = collect(options);
    const entriesByFile = entriesFrom(byFile, fingerprintOf);
    let baselineByFile;
    try {
      baselineByFile = await readBaseline(resolveBaseline());
    } catch (err) {
      // Re-seeding over a version 1 baseline is the sanctioned migration, but
      // only deliberately: --force is what says "I have read the diff".
      if (!force) throw err;
      baselineByFile = new Map();
    }

    const added = newFindings(entriesByFile, baselineByFile);

    if (added.size > 0 && !force) {
      process.stderr.write(
        `${id}: refusing to add ${totalOf(added)} finding(s) to the baseline (down-only ratchet)\n\n`,
      );
      for (const [file, entries] of added) {
        for (const entry of entries) {
          process.stderr.write(`  ${file} :: ${entry}\n`);
        }
      }
      process.stderr.write(
        "\nFix them, or pass --force for an intentional initial seed.\n",
      );
      return 1;
    }

    await writeBaseline(resolveBaseline(), entriesByFile);
    const total = totalOf(entriesByFile);
    process.stdout.write(
      `${id}: wrote ${relative(repoRoot, resolveBaseline())} ` +
        `(${total} finding(s) across ${entriesByFile.size} file(s))\n`,
    );
    return 0;
  }

  return { check, list, json, updateBaseline };
}

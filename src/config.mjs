// contract-fidelity: what counts as a contract, and how strict to be about it.
//
// Everything here was hardcoded to one organisation's generated clients and
// one team's policy. Both are choices, not universals: another codebase
// generates from a different tool whose descriptions read differently, and a
// team consuming a flakier API may reasonably validate at its boundary rather
// than trust the schema. Neither belongs baked into the analysis.
//
// Config is read from `contract-fidelity.config.json` beside the repo root, or
// from the `contractFidelity` key in package.json. Absent both, the defaults
// below apply.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  // Which declaration files carry contracts. A value of "@acme" matches both
  // `node_modules/@acme/...` and pnpm's `node_modules/.pnpm/@acme+...`, and a
  // bare directory name matches an in-repo generated client. Required: there
  // is no sensible default, and guessing one would make a scan pass while
  // checking nothing.
  contractPackages: [],

  // Whether a guard sitting directly on a contract read — nothing widened in
  // between — is a violation. True means the contract is the authority and
  // re-deriving it at runtime is a bug. False means checks at the boundary
  // are the team's deliberate choice and only widened cases are reported.
  trustContract: true,

  // Extra prose patterns for guarantees a generator writes into descriptions
  // but cannot express in the type. Each is { id, source, flags, kind }
  // where kind is one of positive | non-negative | range.
  docPatterns: [],

  // The tsconfig whose program is analysed.
  tsconfig: "tsconfig.json",

  // Where the down-only baselines are written, relative to the project root.
  baselineDir: ".contract-fidelity",

  // Roots scanned for violations, relative to the repo root.
  scanRoots: ["src"],
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`contract-fidelity: could not read ${path}: ${err.message}`);
  }
}

export function loadConfig(repoRoot) {
  const standalone = readJson(join(repoRoot, "contract-fidelity.config.json"));
  const pkg = readJson(join(repoRoot, "package.json"));
  const fromPkg = pkg?.contractFidelity ?? null;

  if (standalone && fromPkg) {
    throw new Error(
      "contract-fidelity: configured twice — contract-fidelity.config.json and package.json#contractFidelity. Keep one.",
    );
  }

  const config = { ...DEFAULTS, ...(standalone ?? fromPkg ?? {}) };

  if (
    !Array.isArray(config.contractPackages) ||
    config.contractPackages.length === 0
  ) {
    throw new Error(
      "contract-fidelity: `contractPackages` must list at least one package scope — without it nothing is a contract and the scan passes vacuously.",
    );
  }
  return config;
}

// A path test for "declared by one of the contract packages", covering both
// a plain node_modules layout and pnpm's content-addressed store.
export function contractPathMatcher(contractPackages) {
  const alternatives = contractPackages
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(
    `[/\\\\](?:${alternatives})[/\\\\+]|(?:${alternatives})\\+`,
  );
}

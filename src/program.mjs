// narrowing-loss: the shared TypeScript program.
//
// Both scanners in this directory need the same thing — a real type checker
// over `src`, with the generated clients resolved — and building it twice in
// one file was the only duplication worth extracting.

import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, contractPathMatcher } from "./config.mjs";

// The project under analysis is wherever the CLI was invoked — NOT wherever
// this package happens to be installed. Deriving it from the tool's own path
// worked only while the tool was vendored inside the repo it analysed.
// `CONTRACT_FIDELITY_ROOT` exists so tests can point at a fixture tree.
export const REPO_ROOT = process.env.CONTRACT_FIDELITY_ROOT ?? process.cwd();

// Loaded on FIRST USE, not on import. A library that throws merely because it
// was imported cannot be embedded, and its own tests — which build their own
// programs over fixtures — need no project config at all.
let cachedConfig = null;
let cachedPathRe = null;

export function getConfig() {
  cachedConfig ??= loadConfig(REPO_ROOT);
  return cachedConfig;
}

export function contractPathRe() {
  cachedPathRe ??= contractPathMatcher(getConfig().contractPackages);
  return cachedPathRe;
}

// Tests deliberately construct out-of-contract values, so they are never a
// violation site. Both scanners still READ them when censusing writers — a
// test that supplies an unconstrained value proves a branch is reachable.
export const TEST_FILE_RE = /(?:^|[/.])[^/]+\.(?:test|spec)\.[cm]?[tj]sx?$/;

export function isTestFile(fileName) {
  return TEST_FILE_RE.test(fileName) || fileName.includes("/src/test/");
}

export function inSrc(fileName) {
  return getConfig().scanRoots.some((root) =>
    fileName.includes(`${REPO_ROOT}/${root}/`),
  );
}

export function createProgram() {
  const raw = ts.readConfigFile(join(REPO_ROOT, getConfig().tsconfig), ts.sys.readFile);
  if (raw.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, REPO_ROOT);
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  const clientFiles = program
    .getSourceFiles()
    .filter((f) => contractPathRe().test(f.fileName));
  if (clientFiles.length === 0) {
    // Passing vacuously would be worse than failing: the whole policy is
    // defined by the client contracts.
    throw new Error(
      `no contract declarations for ${getConfig().contractPackages.join(", ")} in the program — ` +
        "check `contractPackages`, and that dependencies are installed",
    );
  }
  return program;
}

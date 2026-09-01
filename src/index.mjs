// Programmatic entry point, for embedding the analysis in another tool.
export { analyzeProgram, collectViolations as collectDeadCode } from "./no-narrowing-loss.mjs";
export { collectViolations as collectWidening } from "./no-widened-fields.mjs";
export { constraintFromDoc, decideNumericComparison } from "./constraints.mjs";
export { loadConfig } from "./config.mjs";

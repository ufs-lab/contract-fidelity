// Three census defects, each proven by one declaration.

// (1) The join compares whole guarantees, not kinds. A select's `value` is
// written from two different literal unions: the union of both is what it
// holds, and narrowing to either would break the other caller.
export type Scope = "site" | "ledger";
export type Side = "debit" | "credit";
export interface Choice {
  value: string;
}
export function chooseScope(scope: Scope): Choice {
  return { value: scope };
}
export function chooseSide(side: Side): Choice {
  return { value: side };
}

// (2) An expression-bodied arrow returning an array flows each element into
// the declared element type. The literal inside `.map` is typed by the
// callback's own inference, so only this flow can see `output` left out.
export interface Step {
  name: string;
  output?: Record<string, unknown>;
}
const NAMES = ["plan", "post"] as const;
export const initialSteps = (): Step[] => NAMES.map((name) => ({ name }));
export function completed(name: string, output: Record<string, unknown>): Step {
  return { name, output };
}

// (3) A read through `?.` is undefined whenever its object is, whatever the
// field guarantees: the `?? 2` below is live even though every caller that
// passes options passes `indent`.
export interface Indented {
  indent?: number;
}
export function render(value: string, options?: Indented): string {
  return `${value}:${String(options?.indent ?? 2)}`;
}
export function renderWide(value: string, width: number): string {
  return render(value, { indent: width }) + render(value);
}

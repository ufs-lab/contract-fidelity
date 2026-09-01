import type { Movement } from "../clients/@acme/fake-client/api";

// Widened, but never guarded anywhere: invisible to `dead-code`, and
// the reason the sibling check exists.
interface WidenedVM {
  optionalName?: string;
  nullableName: string | null;
  flatScope: string;
  keptName: string;
  keptScope: "HOUSE" | "CLIENT" | "GROUP";
}

export function buildWidened(m: Movement): WidenedVM {
  return {
    optionalName: m.label,
    nullableName: m.label,
    flatScope: m.scope,
    keptName: m.label,
    keptScope: m.scope,
  };
}

// A field with a second, unconstrained writer is not a widening we can prove.
interface MixedVM {
  mixedName?: string;
}

export function buildMixedFromContract(m: Movement): MixedVM {
  return { mixedName: m.label };
}

export function buildMixedFromAnywhere(value: string | undefined): MixedVM {
  return { mixedName: value };
}

// --- a documented range has no narrower type to move to --------------------

// `amount` carries "must be > 0", which TypeScript cannot express either way.
// Reporting this would demand an edit that does not exist; the guarantee is
// enforced by dead-code, which needs a dead guard to prove harm.
interface AmountVM {
  amount: number;
}

export function buildAmount(m: Movement): AmountVM {
  return { amount: m.amount };
}

// --- values that arrive by deserialization ---------------------------------

// Every value of this shape but the one below comes off the wire, where the
// write census cannot see it. Narrowing `label` would make the type lie about
// what the endpoint actually returns.
interface WireShape {
  wireLabel?: string;
}

interface WireClient {
  fetchOne: (id: string) => Promise<WireShape>;
}

export function buildWire(
  m: Movement,
  client: WireClient,
): [WireShape, Promise<WireShape>] {
  return [{ wireLabel: m.label }, client.fetchOne("x")];
}

// --- a guarantee copied through an intermediate view model -----------------

// StageOne mirrors the contract faithfully. StageTwo then widens the SAME
// value, but its write reads StageOne, not a client property - so a
// single-pass census resolves nothing and skips it in silence. This is the
// shape CurrencyExposureAccountDetailVM had, found only when narrowing its
// source broke the typecheck.
interface StageOne {
  carried: string;
}

interface StageTwo {
  carried: string | undefined;
}

export function buildStageOne(m: Movement): StageOne {
  return { carried: m.label };
}

export function buildStageTwo(one: StageOne): StageTwo {
  return { carried: one.carried };
}

// A field fed from the deserialized shape must inherit NOTHING. WireShape's
// census is incomplete, so letting it prove a guarantee would launder one it
// does not have into everything downstream.
interface DownstreamOfWire {
  fromWire?: string;
}

export function buildDownstreamOfWire(w: WireShape): DownstreamOfWire {
  return { fromWire: w.wireLabel };
}

// --- a collection whose element type is wider than its contents ------------

export function buildNameList(m: Movement): (string | null)[] {
  const names: (string | null)[] = [m.label];
  return names;
}

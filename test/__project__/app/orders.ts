import type { Movement } from "../clients/@acme/fake-client/api";

// `amount` is documented as always > 0, so this guard can never be false.
// A scanner that only looks in `src/` never sees this file.
export function describe(m: Movement): string {
  if (m.amount > 0) {
    return `${m.label}: ${String(m.amount)}`;
  }
  return "empty";
}

// `label` is required on the contract, so declaring it optional here widens
// it and invents an absent case the API never produces.
export interface OrderRow {
  label?: string;
}

export function toRow(m: Movement): OrderRow {
  return { label: m.label };
}

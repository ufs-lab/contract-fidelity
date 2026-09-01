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
  // An enum union flattened to `string`. The suggestion must name the alias,
  // not spell the members out.
  scope: string;
}

export function toRow(m: Movement): OrderRow {
  return { label: m.label, scope: m.scope };
}

// `note` is optional in the schema, so every one of these is legal and no
// scanner may delete it. `optional-fields` counts them so the schema can be
// fixed at source.
export function noteOf(m: Movement): string {
  return m.note ?? "none";
}

export function hasNote(m: Movement): boolean {
  return m.note !== undefined;
}

import type { Movement } from "../clients/@acme/fake-client/api";

// Each of these drops a guarantee at a declaration that is not a field.

export function widenedLocalCase(m: Movement): string {
  const widenedLocal: string | undefined = m.label;
  return widenedLocal ?? "-";
}

export function faithfulLocalCase(m: Movement): string {
  const faithfulLocal: string = m.label;
  return faithfulLocal;
}

export function widenedReturn(m: Movement): string | undefined {
  return m.label;
}

export function widenedCast(m: Movement): unknown {
  return m.label as string | undefined;
}

export function widenedCollection(m: Movement): (string | null)[] {
  const labels: (string | null)[] = [m.label];
  return labels;
}

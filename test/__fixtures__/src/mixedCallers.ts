import type { Movement } from "../clients/@acme/fake-client/api";

// One caller passes a contract-guaranteed value, the other a genuinely
// nullable local. The `?? "-"` branch is reachable, so nothing may be
// reported: this is the census doing its job.
function render(value: string | null): string {
  return value ?? "-";
}

export function fromContract(m: Movement): string {
  return render(m.label);
}

export function fromAnywhere(value: string | null): string {
  return render(value);
}

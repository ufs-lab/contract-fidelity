import { seededByTestCaller } from "./holes";
import type { Row } from "./local";

// The only caller of `seededByTestCaller` in the whole program, and it is a
// test. A test passes whatever the test needs, so this call proves nothing
// about what production supplies.
export function useSeeded(row: Row): string {
  return seededByTestCaller(row.id);
}

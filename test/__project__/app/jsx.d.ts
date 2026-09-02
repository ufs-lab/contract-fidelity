// The smallest JSX namespace a checker needs, so the fixture project can hold
// components without depending on React. `jsx: preserve` in the tsconfig
// leaves the elements alone; only the checker reads them.
declare namespace JSX {
  interface Element {
    readonly kind: "element";
  }
  interface ElementAttributesProperty {
    props: Record<string, unknown>;
  }
  interface IntrinsicElements {
    [name: string]: unknown;
  }
}

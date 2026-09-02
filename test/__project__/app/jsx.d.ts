// The smallest JSX namespace a checker needs, so the fixture project can hold
// components without depending on React. `jsx: preserve` in the tsconfig
// leaves the elements alone; only the checker reads them.
declare namespace JSX {
  interface Element {
    readonly kind: "element";
  }
  // React declares this too, so a component's attributes are contextually
  // typed `IntrinsicAttributes & Props`: an intersection, never a plain object.
  interface IntrinsicAttributes {
    key?: string;
  }
  interface ElementAttributesProperty {
    props: Record<string, unknown>;
  }
  interface IntrinsicElements {
    [name: string]: unknown;
  }
}

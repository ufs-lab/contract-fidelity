// Four props, four census holes a real codebase exposed. Two must be
// reported and two must not; each answer hinges on one rule.
export interface PanelProps {
  label: string;
  // NOT reported: reaches <Panel> through a spread whose source is an
  // inferred union, and one branch of that union has no `depth`.
  depth?: number;
  // NOT reported: reaches paint() through a `Partial<PanelProps>` spread.
  width?: number;
  // Reported: every write is a present string, one of them the literal
  // "dark". A literal states its base type; `"dark"` is a string.
  tone?: string;
  // Reported: every write is a present number, and the `{ ...props }` in
  // reprint() is the type spread into itself, which omits nothing.
  span?: number;
}
// A component's attributes are contextually typed `IntrinsicAttributes &
// PanelProps`: an intersection. The census must see through it, or every
// component in a React program is invisible to the JSX write, omission and
// spread rules.
export function Panel(props: PanelProps): JSX.Element {
  return props.depth === undefined ? { kind: "element" } : { kind: "element" };
}
function multiProps(multi: { depth: number }): { depth: number } {
  return { depth: multi.depth };
}
export function render(multi: { depth: number } | undefined, n: number, tone: string): string {
  const gridProps = multi !== undefined ? { ...multiProps(multi) } : {};
  const el = <Panel label="x" width={n} tone={tone} span={n} {...gridProps} />;
  const el2 = <Panel label="y" depth={n} width={n} tone="dark" span={n} />;
  return String([el, el2].length);
}
function paint(p: PanelProps): number | undefined {
  return p.width === undefined ? p.span : p.width;
}
// A `Partial<PanelProps>` is not a `PanelProps`: every property keeps the
// props field's declaration, and for an already-optional prop the optionality
// matches too, but the value can still lack `width`. Only a source whose type
// IS the target type is the prop spread into itself.
export function fromPartial(extra: Partial<PanelProps>, n: number): number | undefined {
  return paint({ ...extra, label: "z", depth: n, tone: "dark", span: n });
}
// The genuine self-spread: a Props value spread into Props supplies every
// field with what it already held, so nothing is omitted and nothing is lost.
export function reprint(props: PanelProps): number | undefined {
  return paint({ ...props });
}

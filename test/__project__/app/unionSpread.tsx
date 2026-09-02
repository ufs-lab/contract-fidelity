// A `Partial<Props>`-typed object spread into JSX: one branch omits `depth`,
// so the prop can be absent. The self-spread exemption must not swallow it:
// every property of a Partial keeps the props field's declaration, and for
// an already-optional prop the optionality matches too.
export interface PanelProps {
  label: string;
  depth?: number;
}
// React types a component's attributes as `IntrinsicAttributes & P`.
type FC<P> = (props: P & { key?: string }) => string;
export const Panel: FC<PanelProps> = (props) =>
  props.depth === undefined ? props.label : `${props.label}:${String(props.depth)}`;
function multiProps(multi: { depth: number }): Partial<PanelProps> {
  return { depth: multi.depth };
}
export function render(multi: { depth: number } | undefined): string {
  const gridProps: Partial<PanelProps> = multi !== undefined ? { ...multiProps(multi) } : {};
  const el = <Panel label="x" {...gridProps} />;
  const el2 = <Panel label="y" depth={3} />;
  return String([el, el2].length);
}
// The genuine self-spread stays exempt: a Props value spread into Props.
export function reprint(props: PanelProps): string {
  return Panel({ ...props });
}

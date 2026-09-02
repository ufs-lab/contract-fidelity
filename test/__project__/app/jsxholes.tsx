// Census holes a real codebase exposed, in JSX.
//
// Each case here was a finding against correct code, or a write the census
// dropped in silence, until the rule beside it was learnt.

import type { Row } from "./local";

// (H1) A JSX attribute writes the PROPS FIELD.
//
// Keyed on the attribute's own symbol, this write went into a census nobody
// reads, and `caption` was proven present from the object literal below.
export interface CardProps {
  caption: string | null;
}

export function Card(props: CardProps): JSX.Element {
  return { kind: "element" };
}

export function cardProps(row: Row): CardProps {
  return { caption: row.id };
}

export function renderCard(maybe: string | null): JSX.Element {
  return <Card caption={maybe} />;
}

// (H1, the other direction) A props field whose every write is a JSX
// attribute is proven by them, and reported when the declaration is wider.
export interface BadgeProps {
  tone: string | null;
}

export function Badge(props: BadgeProps): JSX.Element {
  return { kind: "element" };
}

export function renderBadge(row: Row): JSX.Element {
  return <Badge tone={row.id} />;
}

// (H3) A JSX spread writes the TARGET's fields, with what the source holds.
export interface PanelSource {
  heading: string | null;
}

export interface PanelProps {
  heading: string | null;
}

export function Panel(props: PanelProps): JSX.Element {
  return { kind: "element" };
}

export function renderPanel(row: Row): JSX.Element {
  return <Panel heading={row.id} />;
}

export function spreadPanel(src: PanelSource): JSX.Element {
  return <Panel {...src} />;
}

// (H5) A component handed to somebody else as a value is rendered with props
// that somebody builds, so its props fields hold values no literal here
// supplies.
export interface TileProps {
  units: string | null;
}

export function Tile(props: TileProps): JSX.Element {
  return { kind: "element" };
}

export function renderTile(row: Row): JSX.Element {
  return <Tile units={row.id} />;
}

export const tileSlot = { component: Tile };

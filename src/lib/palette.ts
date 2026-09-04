/**
 * Table header colours. Muted, pastel-ish hues that read well on both the
 * dark and light canvas. Keys are stored in the diagram file; values are
 * resolved at render time so a theme change never touches saved data.
 */
export interface PaletteColor {
  key: string;
  label: string;
  /** Solid hue used for the header stripe and edge tint. */
  hue: string;
}

export const PALETTE: PaletteColor[] = [
  { key: 'blue', label: 'Blue', hue: '#7aa2f7' },
  { key: 'teal', label: 'Teal', hue: '#4fd1c5' },
  { key: 'green', label: 'Green', hue: '#9ece6a' },
  { key: 'yellow', label: 'Yellow', hue: '#e0af68' },
  { key: 'orange', label: 'Orange', hue: '#ff9e64' },
  { key: 'red', label: 'Red', hue: '#f7768e' },
  { key: 'pink', label: 'Pink', hue: '#f2a6d8' },
  { key: 'purple', label: 'Purple', hue: '#bb9af7' },
  { key: 'indigo', label: 'Indigo', hue: '#8b95ff' },
  { key: 'slate', label: 'Slate', hue: '#8f9bb3' },
];

export function paletteHue(key: string | undefined): string {
  return PALETTE.find((p) => p.key === key)?.hue ?? PALETTE[0].hue;
}

/** Deterministic colour for a table name, so imports look consistent. */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length].key;
}

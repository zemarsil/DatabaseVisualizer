/** Pixel constants shared by the table node CSS, the edge router and the auto-layout. */
export const NODE_MIN_WIDTH = 240;
export const NODE_MAX_WIDTH = 420;
export const HEADER_HEIGHT = 40;
export const ROW_HEIGHT = 28;
export const FOOTER_HEIGHT = 8;
export const EMPTY_TABLE_HEIGHT = 34;

/** Estimated node size before React Flow has measured it. */
export function estimateNodeSize(columns: { name: string; type: string }[]): { width: number; height: number } {
  const longest = columns.reduce((m, c) => Math.max(m, c.name.length + c.type.length), 12);
  const width = Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, 90 + longest * 7.2));
  const height = HEADER_HEIGHT + (columns.length ? columns.length * ROW_HEIGHT : EMPTY_TABLE_HEIGHT) + FOOTER_HEIGHT;
  return { width, height };
}

/** Vertical centre of a column row, relative to the node's top. */
export function rowCenterY(rowIndex: number): number {
  return HEADER_HEIGHT + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
}

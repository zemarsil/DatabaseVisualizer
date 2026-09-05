/**
 * A tiny SVG picture of a diagram for the library cards: tables as tinted
 * rectangles, notes as pale cards, group regions as dashed boxes, and the
 * connections between them. Pure string building, no DOM.
 */
import type { Diagram } from '@shared/types';
import { estimateNodeSize } from './geometry';
import { paletteHue } from './palette';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function diagramThumbnailSvg(d: Diagram, width = 200, height = 120): string {
  const boxes = d.tables.map((t) => {
    const size = estimateNodeSize(t.columns);
    return { id: t.id, x: t.position.x, y: t.position.y, w: size.width, h: size.height, hue: paletteHue(t.color), view: t.kind === 'view', groupId: t.groupId };
  });
  const notes = d.notes.map((n) => ({ x: n.position.x, y: n.position.y, w: n.width, h: n.height }));
  const all = [...boxes, ...notes];
  if (all.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="8" fill="#1a1e2a"/><text x="50%" y="52%" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#5f677c">empty</text></svg>`;
  }
  const pad = 8;
  const minX = Math.min(...all.map((b) => b.x)) - 20;
  const minY = Math.min(...all.map((b) => b.y)) - 20;
  const maxX = Math.max(...all.map((b) => b.x + b.w)) + 20;
  const maxY = Math.max(...all.map((b) => b.y + b.h)) + 20;
  const scale = Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY));
  const ox = pad + ((width - pad * 2) - (maxX - minX) * scale) / 2;
  const oy = pad + ((height - pad * 2) - (maxY - minY) * scale) / 2;
  const sx = (x: number) => (ox + (x - minX) * scale).toFixed(1);
  const sy = (y: number) => (oy + (y - minY) * scale).toFixed(1);
  const sw = (w: number) => Math.max(1.5, w * scale).toFixed(1);

  const parts: string[] = [`<rect width="${width}" height="${height}" rx="8" fill="#1a1e2a"/>`];
  for (const g of d.groups) {
    const members = boxes.filter((b) => b.groupId === g.id);
    if (!members.length) continue;
    const gx = Math.min(...members.map((b) => b.x)) - 14;
    const gy = Math.min(...members.map((b) => b.y)) - 24;
    const gw = Math.max(...members.map((b) => b.x + b.w)) + 14 - gx;
    const gh = Math.max(...members.map((b) => b.y + b.h)) + 14 - gy;
    parts.push(`<rect x="${sx(gx)}" y="${sy(gy)}" width="${sw(gw)}" height="${sw(gh)}" rx="3" fill="${paletteHue(g.color)}" fill-opacity="0.08" stroke="${paletteHue(g.color)}" stroke-opacity="0.5" stroke-dasharray="3 2" stroke-width="1"/>`);
  }
  const center = new Map(boxes.map((b) => [b.id, { x: b.x + b.w / 2, y: b.y + b.h / 2 }]));
  for (const r of d.relationships) {
    const a = center.get(r.sourceTableId);
    const b = center.get(r.targetTableId);
    if (!a || !b) continue;
    const dash = r.kind === 'fk' ? '' : ' stroke-dasharray="3 2"';
    parts.push(`<line x1="${sx(a.x)}" y1="${sy(a.y)}" x2="${sx(b.x)}" y2="${sy(b.y)}" stroke="#6b7590" stroke-width="1" stroke-opacity="0.8"${dash}/>`);
  }
  for (const n of notes) {
    parts.push(`<rect x="${sx(n.x)}" y="${sy(n.y)}" width="${sw(n.w)}" height="${sw(n.h)}" rx="2" fill="#e0af68" fill-opacity="0.35"/>`);
  }
  for (const b of boxes) {
    const headerH = Math.max(2, Math.min(b.h, 40) * scale);
    parts.push(`<rect x="${sx(b.x)}" y="${sy(b.y)}" width="${sw(b.w)}" height="${sw(b.h)}" rx="2" fill="${b.hue}" fill-opacity="0.22" stroke="${b.hue}" stroke-opacity="${b.view ? 0.5 : 0.8}" stroke-width="1"${b.view ? ' stroke-dasharray="2 2"' : ''}/>`);
    parts.push(`<rect x="${sx(b.x)}" y="${sy(b.y)}" width="${sw(b.w)}" height="${headerH.toFixed(1)}" rx="2" fill="${b.hue}" fill-opacity="0.85"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${parts.join('')}</svg>`;
}

export function diagramThumbnail(d: Diagram, width = 200, height = 120): string {
  const svg = diagramThumbnailSvg(d, width, height);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function thumbnailAlt(d: Diagram): string {
  return esc(`${d.name}: ${d.tables.length} tables`);
}

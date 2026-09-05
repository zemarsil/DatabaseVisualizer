/**
 * Share a diagram through the URL: the whole file is compressed and put in the
 * hash, so a classmate opens it without any file exchange or server storage.
 *
 * Integrator hooks: `copyShareLink(diagram)` for a menu item, and the
 * `<ShareLinkLoader />` component (src/components/ShareLinkLoader.tsx) mounted
 * once in the app to open a link on load.
 */
import type { Diagram } from '@shared/types';
import { parseDiagramFile } from './io';

const HASH_KEY = 'd';
/** Browsers cope with far longer URLs, but chat apps and some proxies truncate around here. */
export const SHARE_URL_SOFT_LIMIT = 30_000;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>);
  void writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function hasCompression(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/** Compact JSON without the viewport: the recipient's window is a different size anyway. */
function compactJson(d: Diagram): string {
  const { viewport: _viewport, ...rest } = d;
  return JSON.stringify(rest);
}

export async function encodeDiagramForUrl(d: Diagram): Promise<string> {
  const bytes = new TextEncoder().encode(compactJson(d));
  if (hasCompression()) {
    const deflated = await pipe(bytes, new CompressionStream('deflate-raw'));
    return `z:${toBase64Url(deflated)}`;
  }
  return `j:${toBase64Url(bytes)}`;
}

export async function decodeDiagramFromUrl(payload: string): Promise<Diagram> {
  const sep = payload.indexOf(':');
  const scheme = sep === -1 ? 'j' : payload.slice(0, sep);
  const body = sep === -1 ? payload : payload.slice(sep + 1);
  let bytes = fromBase64Url(body);
  if (scheme === 'z') {
    if (!hasCompression()) throw new Error('This browser cannot decompress shared links.');
    bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  } else if (scheme !== 'j') {
    throw new Error('Unknown share link format.');
  }
  return parseDiagramFile(new TextDecoder().decode(bytes));
}

export async function buildShareUrl(d: Diagram): Promise<string> {
  const payload = await encodeDiagramForUrl(d);
  const base = typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`;
  return `${base}#${HASH_KEY}=${payload}`;
}

export function shareUrlSizeWarning(url: string): string | null {
  if (url.length <= SHARE_URL_SOFT_LIMIT) return null;
  return `The link is ${Math.round(url.length / 1000)}k characters long; some chat apps and browsers truncate links that size. Sharing the .dbviz.json file is safer for big diagrams.`;
}

export function readSharedPayloadFromLocation(): string | null {
  if (typeof location === 'undefined') return null;
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get(HASH_KEY);
}

export function clearSharedPayloadFromLocation(): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
}

export async function copyShareLink(d: Diagram): Promise<{ url: string; warning: string | null }> {
  const url = await buildShareUrl(d);
  await navigator.clipboard.writeText(url);
  return { url, warning: shareUrlSizeWarning(url) };
}

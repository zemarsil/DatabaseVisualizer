import { describe, expect, it } from 'vitest';
import { sampleDiagram } from '../src/lib/sample';
import { decodeDiagramFromUrl, encodeDiagramForUrl, shareUrlSizeWarning, SHARE_URL_SOFT_LIMIT } from '../src/lib/share';

describe('share links', () => {
  it('round-trips the sample diagram through a compressed payload', async () => {
    const d = sampleDiagram();
    const payload = await encodeDiagramForUrl(d);
    expect(payload.startsWith('z:')).toBe(true);
    expect(payload).toMatch(/^z:[A-Za-z0-9_-]+$/);
    const back = await decodeDiagramFromUrl(payload);
    expect(back.name).toBe(d.name);
    expect(back.tables.map((t) => t.name)).toEqual(d.tables.map((t) => t.name));
    expect(back.relationships.length).toBe(d.relationships.length);
    expect(back.viewport).toBeUndefined();
  });

  it('decodes the uncompressed fallback too', async () => {
    const d = sampleDiagram();
    const json = JSON.stringify(d);
    const b64 = Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const back = await decodeDiagramFromUrl(`j:${b64}`);
    expect(back.tables.length).toBe(d.tables.length);
  });

  it('rejects unknown schemes and warns about very long links', async () => {
    await expect(decodeDiagramFromUrl('x:abc')).rejects.toThrow();
    expect(shareUrlSizeWarning('a'.repeat(100))).toBeNull();
    expect(shareUrlSizeWarning('a'.repeat(SHARE_URL_SOFT_LIMIT + 1))).toMatch(/truncate/);
  });
});

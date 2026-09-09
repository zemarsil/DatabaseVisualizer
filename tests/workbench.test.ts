import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from '../src/lib/fuzzy';
import { diagramThumbnail, diagramThumbnailSvg } from '../src/lib/thumbnail';
import { checkpointRecord, defaultCheckpointName, recordToDiagram, recordToWorkspace, relativeTime, workspaceRecord } from '../src/lib/library';
import { sampleDiagram } from '../src/lib/sample';
import { emptyDiagram, singleSheetWorkspace } from '../src/lib/model';

describe('fuzzy', () => {
  it('scores prefixes and word starts above scattered matches', () => {
    expect(fuzzyScore('ord', 'orders')).toBeGreaterThan(fuzzyScore('ord', 'word_ordinal')!);
    expect(fuzzyScore('oi', 'order_items')).not.toBeNull();
    expect(fuzzyScore('xyz', 'orders')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('orders', 'orders')).toBe(1000);
  });

  it('filters and ranks items by their best text', () => {
    const items = [
      { label: 'Export SQL script', keys: ['sql'] },
      { label: 'Open SQL tab', keys: [] },
      { label: 'Add table', keys: ['create'] },
    ];
    const out = fuzzyFilter(items, 'sql', (i) => [i.label, ...i.keys]);
    expect(out.map((i) => i.label)).toEqual(['Export SQL script', 'Open SQL tab']);
    expect(fuzzyFilter(items, '', (i) => i.label)).toHaveLength(3);
    expect(fuzzyFilter(items, 'crea', (i) => [i.label, ...i.keys]).map((i) => i.label)).toEqual(['Add table']);
  });
});

describe('thumbnail', () => {
  it('draws every table inside the canvas and encodes as a data URL', () => {
    const d = sampleDiagram();
    const svg = diagramThumbnailSvg(d, 200, 120);
    expect(svg.startsWith('<svg')).toBe(true);
    // one tinted body + one header stripe per table, at least
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(d.tables.length * 2);
    const coords = [...svg.matchAll(/x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    for (const [x, , w] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(200.5);
    }
    expect(diagramThumbnail(d).startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(diagramThumbnailSvg(emptyDiagram())).toContain('empty');
  });
});

describe('library records', () => {
  it('shapes workspace and checkpoint records and reads them back', () => {
    const d = sampleDiagram();
    const rec = workspaceRecord(singleSheetWorkspace(d, 'sht_1'), 'dgm_1', 123);
    expect(rec).toMatchObject({ id: 'dgm_1', name: d.name, dialect: d.dialect, tableCount: d.tables.length, sheetCount: 1, sheetIds: ['sht_1'], updatedAt: 123 });
    expect(recordToDiagram(rec).tables.map((t) => t.name)).toEqual(d.tables.map((t) => t.name));

    // Two sheets: the record counts both, and reading it back keeps them apart.
    const second = emptyDiagram('sqlite', 'Reporting');
    const two = { version: 1 as const, name: 'Shop', activeSheetId: 'sht_2', sheets: [{ id: 'sht_1', diagram: d }, { id: 'sht_2', diagram: second }] };
    const pair = workspaceRecord(two, 'dgm_2', 5);
    expect(pair).toMatchObject({ name: 'Shop', dialect: 'sqlite', tableCount: d.tables.length, sheetCount: 2, sheetIds: ['sht_1', 'sht_2'] });
    expect(recordToWorkspace(pair).sheets.map((sh) => sh.diagram.name)).toEqual([d.name, 'Reporting']);
    const ck = checkpointRecord(d, 'dgm_1', '  ', 0);
    expect(ck.name).toBe(defaultCheckpointName(0));
    expect(ck.diagramId).toBe('dgm_1');
    expect(checkpointRecord(d, 'dgm_1', 'before refactor').name).toBe('before refactor');
  });

  it('describes times relative to now', () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 days ago');
  });
});

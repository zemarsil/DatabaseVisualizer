/**
 * The clipboard event plumbing: which flavors a copy writes, which one a paste
 * prefers, and that a cut only deletes once the tables are safely elsewhere.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../src/store/useStore';
import { sampleDiagram } from '../src/lib/sample';
import { decodeClipboard } from '../src/lib/clipboard';
import { DBVIZ_FLAVOR, DBVIZ_FLAVOR_WEB, cutSelection, fragmentFromHtml, pasteFromEvent, writeSelectionToEvent } from '../src/lib/canvasActions';

/** A DataTransfer stand-in: a map of format to string, like the real one. */
function fakeEvent(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const clipboardData = {
    types: [...data.keys()],
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  };
  return { event: { clipboardData } as unknown as ClipboardEvent, data };
}

function selectTables(names: string[]): string[] {
  const d = useStore.getState().diagram;
  const ids = names.map((n) => d.tables.find((t) => t.name === n)!.id);
  useStore.getState().setSelection({ tableIds: ids, noteIds: [], relationshipId: null, groupId: null });
  return ids;
}

beforeEach(() => {
  useStore.setState({ diagram: sampleDiagram(), past: [], future: [] });
  useStore.getState().clearSelection();
});

describe('writeSelectionToEvent', () => {
  it('offers the DDL, the rich-text mirror and the diagram fragment', () => {
    selectTables(['orders', 'order_items']);
    const { event, data } = fakeEvent();
    expect(writeSelectionToEvent(event)).toBe(2);
    expect(data.get('text/plain')).toContain('CREATE TABLE orders');
    expect(data.get('text/html')).toContain('<h2>orders</h2>');
    expect(decodeClipboard(data.get(DBVIZ_FLAVOR)!)!.tables).toHaveLength(2);
  });

  it('reports nothing written when the selection holds no table this diagram still has', () => {
    useStore.getState().setSelection({ tableIds: ['gone'], noteIds: [], relationshipId: null, groupId: null });
    const { event, data } = fakeEvent();
    expect(writeSelectionToEvent(event)).toBe(0);
    expect(data.size).toBe(0);
  });
});

describe('pasteFromEvent', () => {
  it('prefers the fragment over the DDL, so a round trip keeps positions and every connection kind', () => {
    const ids = selectTables(['orders', 'order_items']);
    const positions = ids.map((id) => useStore.getState().diagram.tables.find((t) => t.id === id)!.position);
    const { event, data } = fakeEvent();
    writeSelectionToEvent(event);

    const before = useStore.getState().diagram.tables.length;
    const embeds = useStore.getState().diagram.relationships.filter((r) => r.kind === 'embed').length;
    expect(pasteFromEvent({ clipboardData: { ...event.clipboardData, types: [...data.keys()] } } as unknown as ClipboardEvent)).toBe(true);

    const after = useStore.getState().diagram;
    expect(after.tables.length).toBe(before + 2);
    // The SQL fallback would have lost the embed and re-laid the tables out.
    expect(after.relationships.filter((r) => r.kind === 'embed').length).toBe(embeds + 1);
    expect(after.tables.at(-1)!.position).not.toEqual(positions[0]);
  });

  it('reads the fragment under the name the async clipboard API gives it', () => {
    selectTables(['orders']);
    const { event, data } = fakeEvent();
    writeSelectionToEvent(event);
    const { event: web } = fakeEvent({ 'text/plain': data.get('text/plain')!, [DBVIZ_FLAVOR_WEB]: data.get(DBVIZ_FLAVOR)! });

    const before = useStore.getState().diagram.tables.length;
    expect(pasteFromEvent(web)).toBe(true);
    expect(useStore.getState().diagram.tables.length).toBe(before + 1);
  });

  it('falls back to importing DDL that did not come from here', () => {
    const { event } = fakeEvent({ 'text/plain': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);' });
    expect(pasteFromEvent(event)).toBe(true);
    expect(useStore.getState().diagram.tables.some((t) => t.name === 'widgets')).toBe(true);
  });

  it('ignores an empty clipboard', () => {
    expect(pasteFromEvent(fakeEvent().event)).toBe(false);
  });
});

describe('cutSelection', () => {
  it('deletes the tables it copied', () => {
    const ids = selectTables(['order_gaps']);
    const before = useStore.getState().diagram.tables.length;
    cutSelection();
    expect(useStore.getState().diagram.tables.length).toBe(before - 1);
    expect(useStore.getState().diagram.tables.some((t) => t.id === ids[0])).toBe(false);
  });

  it('deletes nothing when the selection has no table left to copy', () => {
    useStore.getState().setSelection({ tableIds: ['gone'], noteIds: [useStore.getState().diagram.notes[0].id], relationshipId: null, groupId: null });
    const notes = useStore.getState().diagram.notes.length;
    cutSelection();
    expect(useStore.getState().diagram.notes.length).toBe(notes);
  });
});

describe('the fragment hidden in the HTML flavor', () => {
  it('rides along as a comment after the markup, so both clipboard APIs can find it', () => {
    selectTables(['orders']);
    const { event, data } = fakeEvent();
    writeSelectionToEvent(event);
    const html = data.get('text/html')!;
    expect(html.startsWith('<h2>orders</h2>')).toBe(true);
    expect(html).toContain('<!--dbviz:');
    expect(decodeClipboard(fragmentFromHtml(html))!.tables).toHaveLength(1);
  });

  it('survives a comment that would otherwise close the HTML comment early', () => {
    const first = useStore.getState().diagram.tables[0];
    useStore.getState().updateTable(first.id, { comment: 'a --> b --> c' });
    selectTables([first.name]);
    const { event, data } = fakeEvent();
    writeSelectionToEvent(event);
    expect(decodeClipboard(fragmentFromHtml(data.get('text/html')!))).not.toBeNull();
  });

  it('recovers the tables when the HTML flavor is all that came through', () => {
    selectTables(['orders']);
    const { event, data } = fakeEvent();
    writeSelectionToEvent(event);
    const { event: htmlOnly } = fakeEvent({ 'text/plain': 'CREATE TABLE unrelated (id INT);', 'text/html': data.get('text/html')! });

    const before = useStore.getState().diagram.tables.length;
    expect(pasteFromEvent(htmlOnly)).toBe(true);
    const after = useStore.getState().diagram;
    expect(after.tables.length).toBe(before + 1);
    expect(after.tables.some((t) => t.name === 'unrelated')).toBe(false);
  });

  it('finds nothing in HTML from anywhere else', () => {
    expect(fragmentFromHtml('<p>hello</p>')).toBe('');
    expect(fragmentFromHtml('<p>hi</p><!--dbviz:not base64 at all-->')).toBe('');
  });
});

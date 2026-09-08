import { describe, expect, it } from 'vitest';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { emptyDiagram } from '../src/lib/model';
import { sampleDiagram } from '../src/lib/sample';
import { useStore } from '../src/store/useStore';

const NIGHTLY = 'nightly rollup';

describe('reverse relationship labels', () => {
  it('survives a save/load round-trip', () => {
    const d = sampleDiagram();
    const flow = d.relationships.find((r) => r.name === NIGHTLY)!;
    flow.inverseName = 'built from';
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.relationships.find((r) => r.id === flow.id)!.inverseName).toBe('built from');
  });

  it('treats an empty reverse label as absent, so the verb supplies one', () => {
    const d = parseDiagramFile(
      JSON.stringify({
        tables: [{ id: 't1', name: 'x', columns: [{ id: 'c1', name: 'id' }] }],
        relationships: [{ id: 'r1', kind: 'flow', sourceTableId: 't1', targetTableId: 't1', inverseName: '' }],
      }),
    );
    expect(d.relationships[0].inverseName).toBeUndefined();
  });

  it('swaps the two labels along with the ends of a flow', () => {
    const d = sampleDiagram();
    const flow = d.relationships.find((r) => r.name === NIGHTLY)!;
    flow.inverseName = 'built from';
    useStore.setState({ diagram: d, past: [], future: [] });

    useStore.getState().swapRelationship(flow.id);

    const after = useStore.getState().diagram.relationships.find((r) => r.id === flow.id)!;
    expect(after.sourceTableId).toBe(flow.targetTableId);
    expect(after.name).toBe('built from');
    expect(after.inverseName).toBe(NIGHTLY);
  });

  it("keeps a foreign key's constraint name on the constraint when the key moves", () => {
    const d = emptyDiagram('postgresql', 'fk swap');
    d.tables = [
      {
        id: 't1',
        name: 'order_items',
        color: 'blue',
        position: { x: 0, y: 0 },
        columns: [{ id: 'c1', name: 'order_id', type: 'INTEGER', nullable: false, primaryKey: false, unique: false, autoIncrement: false }],
        indexes: [],
        checks: [],
      },
      {
        id: 't2',
        name: 'orders',
        color: 'blue',
        position: { x: 300, y: 0 },
        columns: [{ id: 'c2', name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, unique: false, autoIncrement: false }],
        indexes: [],
        checks: [],
      },
    ];
    d.relationships = [
      { id: 'r1', kind: 'fk', name: 'fk_order_items_orders', inverseName: 'has', sourceTableId: 't1', sourceColumnIds: ['c1'], targetTableId: 't2', targetColumnIds: ['c2'] },
    ];
    useStore.setState({ diagram: d, past: [], future: [] });

    useStore.getState().swapRelationship('r1');

    const after = useStore.getState().diagram.relationships[0];
    expect(after.sourceTableId).toBe('t2');
    expect(after.name).toBe('fk_order_items_orders');
    expect(after.inverseName).toBe('has');
  });
});

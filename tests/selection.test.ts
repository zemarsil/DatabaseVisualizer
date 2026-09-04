import { describe, expect, it } from 'vitest';
import { applyEdgeSelectionChanges, applyNodeSelectionChanges, emptySelection, type Selection } from '../src/lib/selection';

const notes = new Set(['n1', 'n2']);
const isNote = (id: string) => notes.has(id);

const sel = (patch: Partial<Selection> = {}): Selection => ({ ...emptySelection(), ...patch });

describe('applyNodeSelectionChanges', () => {
  it('collects a whole group from one marquee sweep', () => {
    // React Flow emits one select change per node as the box grows over it.
    const next = applyNodeSelectionChanges(sel(), [
      { id: 't1', selected: true },
      { id: 't2', selected: true },
      { id: 'n1', selected: true },
    ], isNote);
    expect(next).toEqual({ tableIds: ['t1', 't2'], noteIds: ['n1'], relationshipId: null, groupId: null });
  });

  it('keeps every note in a mixed group instead of only the last one', () => {
    const next = applyNodeSelectionChanges(sel(), [
      { id: 'n1', selected: true },
      { id: 'n2', selected: true },
      { id: 't1', selected: true },
    ], isNote);
    expect(next?.noteIds).toEqual(['n1', 'n2']);
    expect(next?.tableIds).toEqual(['t1']);
  });

  it('applies deselects, so shrinking the box drops what it left behind', () => {
    const next = applyNodeSelectionChanges(sel({ tableIds: ['t1', 't2'], noteIds: ['n1'] }), [
      { id: 't2', selected: false },
      { id: 'n1', selected: false },
    ], isNote);
    expect(next).toEqual({ tableIds: ['t1'], noteIds: [], relationshipId: null, groupId: null });
  });

  it('takes over from a selected relationship', () => {
    const next = applyNodeSelectionChanges(sel({ relationshipId: 'r1' }), [{ id: 't1', selected: true }], isNote);
    expect(next).toEqual({ tableIds: ['t1'], noteIds: [], relationshipId: null, groupId: null });
  });

  it('leaves a selected relationship alone when the box ends up empty', () => {
    const next = applyNodeSelectionChanges(sel({ tableIds: ['t1'], relationshipId: 'r1' }), [{ id: 't1', selected: false }], isNote);
    expect(next).toEqual({ tableIds: [], noteIds: [], relationshipId: 'r1', groupId: null });
  });

  it('reports no change when the deltas are already applied', () => {
    expect(applyNodeSelectionChanges(sel({ tableIds: ['t1'] }), [{ id: 't1', selected: true }], isNote)).toBeNull();
    expect(applyNodeSelectionChanges(sel(), [{ id: 't1', selected: false }], isNote)).toBeNull();
    expect(applyNodeSelectionChanges(sel(), [], isNote)).toBeNull();
  });

  it('takes over from a selected group', () => {
    const next = applyNodeSelectionChanges(sel({ groupId: 'g1' }), [{ id: 't1', selected: true }], isNote);
    expect(next).toEqual({ tableIds: ['t1'], noteIds: [], relationshipId: null, groupId: null });
  });

  it('leaves a selected group alone when the box ends up empty', () => {
    const next = applyNodeSelectionChanges(sel({ tableIds: ['t1'], groupId: 'g1' }), [{ id: 't1', selected: false }], isNote);
    expect(next).toEqual({ tableIds: [], noteIds: [], relationshipId: null, groupId: 'g1' });
  });

  it('does not duplicate a node that is reported twice', () => {
    const next = applyNodeSelectionChanges(sel({ tableIds: ['t1'] }), [
      { id: 't1', selected: true },
      { id: 't2', selected: true },
      { id: 't2', selected: true },
    ], isNote);
    expect(next?.tableIds).toEqual(['t1', 't2']);
  });
});

describe('applyEdgeSelectionChanges', () => {
  it('replaces the node selection when an edge is clicked', () => {
    const next = applyEdgeSelectionChanges(sel({ tableIds: ['t1', 't2'], noteIds: ['n1'] }), [{ id: 'r1', selected: true }]);
    expect(next).toEqual({ tableIds: [], noteIds: [], relationshipId: 'r1', groupId: null });
  });

  it('clears the relationship when it is deselected', () => {
    expect(applyEdgeSelectionChanges(sel({ relationshipId: 'r1' }), [{ id: 'r1', selected: false }])).toEqual(emptySelection());
  });

  it('clears a selected group when an edge is clicked', () => {
    const next = applyEdgeSelectionChanges(sel({ groupId: 'g1' }), [{ id: 'r1', selected: true }]);
    expect(next).toEqual({ tableIds: [], noteIds: [], relationshipId: 'r1', groupId: null });
  });

  it('ignores a deselect for an edge that was not selected', () => {
    expect(applyEdgeSelectionChanges(sel({ tableIds: ['t1'] }), [{ id: 'r9', selected: false }])).toBeNull();
  });

  it('reports no change when the edge is already the whole selection', () => {
    expect(applyEdgeSelectionChanges(sel({ relationshipId: 'r1' }), [{ id: 'r1', selected: true }])).toBeNull();
  });

  it('keeps only the last edge when several are reported at once', () => {
    const next = applyEdgeSelectionChanges(sel(), [
      { id: 'r1', selected: true },
      { id: 'r2', selected: true },
    ]);
    expect(next).toEqual({ tableIds: [], noteIds: [], relationshipId: 'r2', groupId: null });
  });
});

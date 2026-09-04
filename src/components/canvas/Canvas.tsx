import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { Crosshair, X } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { openContextMenu } from '@/components/ui/ContextMenu';
import type { SelectionChange } from '@/lib/selection';
import { paletteHue } from '@/lib/palette';
import { TableNode, HEADER_HANDLE_SUFFIX, type TableNodeType } from './TableNode';
import { NoteNode, type NoteNodeType } from './NoteNode';
import { RelationEdge, type RelationEdgeType } from './RelationEdge';

const nodeTypes = { table: TableNode, note: NoteNode };
const edgeTypes = { relation: RelationEdge };

type CanvasNode = TableNodeType | NoteNodeType;

function parseHandle(handle: string | null | undefined): { kind: 'column'; columnId: string } | { kind: 'header'; ownerId: string } | null {
  if (!handle) return null;
  if (handle.endsWith(HEADER_HANDLE_SUFFIX)) return { kind: 'header', ownerId: handle.slice(0, -HEADER_HANDLE_SUFFIX.length) };
  const i = handle.lastIndexOf('|');
  if (i === -1) return null;
  return { kind: 'column', columnId: handle.slice(0, i) };
}

export function Canvas() {
  const diagram = useStore((s) => s.diagram);
  const selection = useStore((s) => s.selection);
  const trace = useStore((s) => s.trace);
  const nodeSizes = useStore((s) => s.nodeSizes);
  const fitViewNonce = useStore((s) => s.fitViewNonce);
  const focusTableId = useStore((s) => s.focusTableId);
  const theme = useStore((s) => s.theme);

  const moveItems = useStore((s) => s.moveItems);
  const beginDrag = useStore((s) => s.beginDrag);
  const endDrag = useStore((s) => s.endDrag);
  const setNodeSize = useStore((s) => s.setNodeSize);
  const setSelection = useStore((s) => s.setSelection);
  const clearSelection = useStore((s) => s.clearSelection);
  const applyNodeSelection = useStore((s) => s.applyNodeSelection);
  const applyEdgeSelection = useStore((s) => s.applyEdgeSelection);
  const removeElements = useStore((s) => s.removeElements);
  const addRelationship = useStore((s) => s.addRelationship);
  const addTable = useStore((s) => s.addTable);
  const mutate = useStore((s) => s.mutate);
  const focusTable = useStore((s) => s.focusTable);
  const setTraceEndpoints = useStore((s) => s.setTraceEndpoints);
  const setTracePicking = useStore((s) => s.setTracePicking);
  const runTrace = useStore((s) => s.runTrace);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const toast = useStore((s) => s.toast);
  const loadSample = useStore((s) => s.loadSample);
  const openDrawer = useStore((s) => s.openDrawer);

  const { fitView, screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  /*
   * True while a marquee (shift + drag) is being dragged. React Flow marks every edge
   * touching a boxed node as selected, and an edge selection replaces the node selection,
   * so those edge changes have to be dropped or the box loses the group it just picked up.
   */
  const boxSelecting = useRef(false);

  useEffect(() => {
    // onSelectionEnd is skipped when a pointer is cancelled or the window loses focus.
    const stop = () => void (boxSelecting.current = false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
  }, []);

  const tableMap = useMemo(() => new Map(diagram.tables.map((t) => [t.id, t])), [diagram.tables]);
  const fkColumnsByTable = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of diagram.relationships) {
      if (r.kind !== 'fk') continue;
      const arr = m.get(r.sourceTableId) ?? [];
      arr.push(...r.sourceColumnIds);
      m.set(r.sourceTableId, arr);
    }
    return m;
  }, [diagram.relationships]);
  const embedColumnsByTable = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of diagram.relationships) {
      if (r.kind !== 'embed' || !r.sourceColumnIds[0]) continue;
      const arr = m.get(r.sourceTableId) ?? [];
      arr.push(r.sourceColumnIds[0]);
      m.set(r.sourceTableId, arr);
    }
    return m;
  }, [diagram.relationships]);

  const tracing = Boolean(trace.result);
  const traceTables = useMemo(() => new Set(trace.result?.tableIds ?? []), [trace.result]);
  const traceRels = useMemo(() => new Set(trace.result?.relationshipIds ?? []), [trace.result]);
  const selectedTableId = selection.tableIds.length === 1 ? selection.tableIds[0] : null;

  const nodes = useMemo<CanvasNode[]>(() => {
    const tableNodes: TableNodeType[] = diagram.tables.map((t) => {
      const role = !trace.result
        ? null
        : t.id === trace.result.from.id
          ? 'from'
          : t.id === trace.result.to.id
            ? 'to'
            : traceTables.has(t.id)
              ? 'via'
              : null;
      return {
        id: t.id,
        type: 'table',
        position: t.position,
        data: {
          table: t,
          fkColumnIds: fkColumnsByTable.get(t.id) ?? [],
          embedColumnIds: embedColumnsByTable.get(t.id) ?? [],
          dimmed: tracing && !traceTables.has(t.id),
          traceRole: role,
          picking: trace.picking,
        },
        selected: selection.tableIds.includes(t.id),
        measured: nodeSizes[t.id],
      };
    });
    const noteNodes: NoteNodeType[] = diagram.notes.map((n) => ({
      id: n.id,
      type: 'note',
      position: n.position,
      width: n.width,
      height: n.height,
      data: { note: n, dimmed: tracing },
      selected: selection.noteIds.includes(n.id),
      measured: nodeSizes[n.id],
    }));
    return [...noteNodes, ...tableNodes];
  }, [
    diagram.tables,
    diagram.notes,
    selection.tableIds,
    selection.noteIds,
    nodeSizes,
    trace.result,
    trace.picking,
    traceTables,
    tracing,
    fkColumnsByTable,
    embedColumnsByTable,
  ]);

  const edges = useMemo<RelationEdgeType[]>(() => {
    const out: RelationEdgeType[] = [];
    for (const r of diagram.relationships) {
      const src = tableMap.get(r.sourceTableId);
      const tgt = tableMap.get(r.targetTableId);
      if (!src || !tgt) continue;
      const sourceRow = r.sourceColumnIds.length ? src.columns.findIndex((c) => c.id === r.sourceColumnIds[0]) : -1;
      const targetRow = r.targetColumnIds.length ? tgt.columns.findIndex((c) => c.id === r.targetColumnIds[0]) : -1;
      const srcCol = src.columns.find((c) => c.id === r.sourceColumnIds[0]);
      out.push({
        id: r.id,
        type: 'relation',
        source: r.sourceTableId,
        target: r.targetTableId,
        selected: selection.relationshipId === r.id,
        data: {
          relationship: r,
          sourceRow,
          targetRow,
          hue: paletteHue(src.color),
          dimmed: tracing && !traceRels.has(r.id),
          traced: traceRels.has(r.id),
          attached: selectedTableId !== null && (r.sourceTableId === selectedTableId || r.targetTableId === selectedTableId),
          optional: r.kind === 'fk' && Boolean(srcCol?.nullable),
        },
      });
    }
    return out;
  }, [diagram.relationships, tableMap, selection.relationshipId, tracing, traceRels, selectedTableId]);

  /* ---------- change handlers ---------- */

  const noteIds = useMemo(() => new Set(diagram.notes.map((n) => n.id)), [diagram.notes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moves: { id: string; position: { x: number; y: number } }[] = [];
      const selects: SelectionChange[] = [];
      for (const ch of changes) {
        switch (ch.type) {
          case 'position':
            if (ch.position) moves.push({ id: ch.id, position: ch.position });
            break;
          case 'dimensions':
            if (ch.dimensions) {
              if (ch.setAttributes && noteIds.has(ch.id)) {
                const dims = ch.dimensions;
                mutate(
                  (d) => {
                    const n = d.notes.find((x) => x.id === ch.id);
                    if (n) {
                      n.width = dims.width;
                      n.height = dims.height;
                    }
                  },
                  { history: false },
                );
              }
              setNodeSize(ch.id, ch.dimensions);
            }
            break;
          case 'select':
            selects.push({ id: ch.id, selected: ch.selected });
            break;
          // 'remove' is handled in onDelete so a group delete is a single undo step.
          default:
            break;
        }
      }
      if (moves.length) moveItems(moves);
      if (selects.length) applyNodeSelection(selects, (id) => noteIds.has(id));
    },
    [noteIds, moveItems, mutate, setNodeSize, applyNodeSelection],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      // Marquee-driven edge selection is ignored: see the boxSelecting ref above.
      if (boxSelecting.current) return;
      const selects: SelectionChange[] = [];
      for (const ch of changes) {
        if (ch.type === 'select') selects.push({ id: ch.id, selected: ch.selected });
      }
      if (selects.length) applyEdgeSelection(selects);
    },
    [applyEdgeSelection],
  );

  const onDelete = useCallback(
    ({ nodes: goneNodes, edges: goneEdges }: { nodes: CanvasNode[]; edges: Edge[] }) => {
      removeElements({
        tableIds: goneNodes.filter((n) => n.type === 'table').map((n) => n.id),
        noteIds: goneNodes.filter((n) => n.type === 'note').map((n) => n.id),
        relationshipIds: goneEdges.map((e) => e.id),
      });
    },
    [removeElements],
  );

  const isValidConnection = useCallback<IsValidConnection<Edge>>(
    (c) => {
      if (!c.source || !c.target) return false;
      if (!tableMap.has(c.source) || !tableMap.has(c.target)) return false;
      const a = parseHandle(c.sourceHandle);
      const b = parseHandle(c.targetHandle);
      if (!a || !b) return false;
      if (a.kind === 'column' && b.kind === 'column' && a.columnId === b.columnId) return false;
      return true;
    },
    [tableMap],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const a = parseHandle(c.sourceHandle);
      const b = parseHandle(c.targetHandle);
      if (!a || !b || !c.source || !c.target) return;
      if (a.kind === 'column' && b.kind === 'column') {
        const dup = diagram.relationships.find(
          (r) => r.kind === 'fk' && r.sourceColumnIds.length === 1 && r.sourceColumnIds[0] === a.columnId && r.targetColumnIds[0] === b.columnId,
        );
        if (dup) {
          toast('info', 'That foreign key already exists.');
          setSelection({ relationshipId: dup.id, tableIds: [], noteIds: [] });
          return;
        }
        addRelationship({ kind: 'fk', sourceTableId: c.source, sourceColumnIds: [a.columnId], targetTableId: c.target, targetColumnIds: [b.columnId] });
      } else {
        addRelationship({
          kind: 'flow',
          sourceTableId: c.source,
          sourceColumnIds: a.kind === 'column' ? [a.columnId] : [],
          targetTableId: c.target,
          targetColumnIds: b.kind === 'column' ? [b.columnId] : [],
        });
      }
    },
    [diagram.relationships, addRelationship, toast, setSelection],
  );

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (!trace.picking || node.type !== 'table') return;
      if (!trace.fromId) {
        setTraceEndpoints(node.id, null);
      } else if (node.id !== trace.fromId) {
        setTraceEndpoints(trace.fromId, node.id);
        // runTrace reads the store synchronously after the update above
        setTimeout(() => runTrace(), 0);
      }
    },
    [trace.picking, trace.fromId, setTraceEndpoints, runTrace],
  );

  /* ---------- right-click menus ---------- */

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      openContextMenu(e, { type: 'pane', flowPosition: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
    },
    [screenToFlowPosition],
  );

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      // Right-clicking inside a group selection keeps it and acts on the group.
      const isNote = node.type === 'note';
      const groupSize = selection.tableIds.length + selection.noteIds.length;
      if (groupSize > 1 && (isNote ? selection.noteIds : selection.tableIds).includes(node.id)) {
        openContextMenu(e, { type: 'selection' });
        return;
      }
      if (isNote) {
        setSelection({ tableIds: [], relationshipId: null, noteIds: [node.id] });
        openContextMenu(e, { type: 'note', noteId: node.id });
        return;
      }
      setSelection({ tableIds: [node.id], relationshipId: null, noteIds: [] });
      const columnId = (e.target as Element | null)?.closest?.('[data-column-id]')?.getAttribute('data-column-id') ?? undefined;
      openContextMenu(e, { type: 'table', tableId: node.id, columnId });
    },
    [selection.tableIds, selection.noteIds, setSelection],
  );

  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      setSelection({ relationshipId: edge.id, tableIds: [], noteIds: [] });
      openContextMenu(e, { type: 'relationship', relationshipId: edge.id });
    },
    [setSelection],
  );

  const onSelectionContextMenu = useCallback(
    (e: React.MouseEvent, picked: Node[]) => {
      const tableIds = picked.filter((n) => n.type === 'table').map((n) => n.id);
      const noteIds = picked.filter((n) => n.type === 'note').map((n) => n.id);
      if (tableIds.length || noteIds.length) setSelection({ tableIds, noteIds, relationshipId: null });
      openContextMenu(e, { type: 'selection' });
    },
    [setSelection],
  );

  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('react-flow__pane')) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addTable({ x: Math.round(pos.x - 120), y: Math.round(pos.y - 20) });
    },
    [screenToFlowPosition, addTable],
  );

  /* ---------- viewport effects ---------- */

  useEffect(() => {
    if (fitViewNonce === 0) return;
    const t1 = setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 80);
    const t2 = setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 350);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [fitViewNonce, fitView]);

  useEffect(() => {
    if (!trace.result) return;
    const ids = trace.result.tableIds.map((id) => ({ id }));
    const t = setTimeout(() => fitView({ nodes: ids, duration: 500, padding: 0.25, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
  }, [trace.result, fitView]);

  useEffect(() => {
    if (!focusTableId) return;
    fitView({ nodes: [{ id: focusTableId }], duration: 500, maxZoom: 1.2, padding: 0.6 });
    focusTable(null);
  }, [focusTableId, fitView, focusTable]);

  const pickingLabel = trace.picking ? (trace.fromId ? `From ${tableMap.get(trace.fromId)?.name ?? '?'}: now click the destination table` : 'Click the starting table') : null;

  return (
    <div ref={wrapperRef} className="app__canvas" onDoubleClick={onPaneDoubleClick}>
      <ReactFlow
        className={`canvas${trace.picking ? ' picking' : ''}`}
        colorMode={theme}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onDelete={onDelete}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={() => setInspectorOpen(true)}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onNodeDragStart={beginDrag}
        onNodeDragStop={endDrag}
        onSelectionDragStart={beginDrag}
        onSelectionDragStop={endDrag}
        onSelectionStart={() => void (boxSelecting.current = true)}
        onSelectionEnd={() => void (boxSelecting.current = false)}
        onPaneClick={() => clearSelection()}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={24}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        selectionKeyCode="Shift"
        // Touching the box is enough; requiring full containment makes the marquee fussy.
        selectionMode={SelectionMode.Partial}
        zoomOnDoubleClick={false}
        minZoom={0.08}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--canvas-dot)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          style={{ width: 160, height: 100 }}
          nodeColor={(n) => (n.type === 'table' ? paletteHue((n.data as { table: { color: string } }).table.color) : 'var(--flow)')}
          nodeStrokeWidth={0}
          maskColor="rgba(0,0,0,0.25)"
        />
      </ReactFlow>
      {pickingLabel && (
        <div className="canvas__picking-banner">
          <Crosshair size={16} />
          <span>{pickingLabel}</span>
          <button className="btn btn--sm btn--icon btn--ghost" title="Cancel" onClick={() => setTracePicking(false)}>
            <X />
          </button>
        </div>
      )}
      {diagram.tables.length === 0 && (
        <div className="canvas__empty">
          <div className="canvas__empty-card">
            <h2>Empty diagram</h2>
            <p>Double-click the canvas or press T to add a table, paste CREATE TABLE statements, or pull a schema from a running database.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn--primary" onClick={() => addTable()}>
                Add table
              </button>
              <button className="btn" onClick={() => openDrawer('import')}>
                Import SQL
              </button>
              <button className="btn" onClick={loadSample}>
                Load example
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

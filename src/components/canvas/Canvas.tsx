import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
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
  const deleteTables = useStore((s) => s.deleteTables);
  const deleteNote = useStore((s) => s.deleteNote);
  const deleteRelationship = useStore((s) => s.deleteRelationship);
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
        data: { table: t, fkColumnIds: fkColumnsByTable.get(t.id) ?? [], dimmed: tracing && !traceTables.has(t.id), traceRole: role, picking: trace.picking },
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
      selected: selection.noteId === n.id,
      measured: nodeSizes[n.id],
    }));
    return [...noteNodes, ...tableNodes];
  }, [diagram.tables, diagram.notes, selection.tableIds, selection.noteId, nodeSizes, trace.result, trace.picking, traceTables, tracing, fkColumnsByTable]);

  const edges = useMemo<RelationEdgeType[]>(() => {
    const prepared = diagram.relationships.map((r) => {
      const src = tableMap.get(r.sourceTableId);
      const tgt = tableMap.get(r.targetTableId);
      if (!src || !tgt) return null;
      const sourceRow = r.sourceColumnIds.length ? src.columns.findIndex((c) => c.id === r.sourceColumnIds[0]) : -1;
      const targetRow = r.targetColumnIds.length ? tgt.columns.findIndex((c) => c.id === r.targetColumnIds[0]) : -1;
      const srcCol = src.columns.find((c) => c.id === r.sourceColumnIds[0]);
      // Relationships sharing identical anchor points would otherwise render as fully overlapping curves.
      const anchorKey = `${r.sourceTableId}#${sourceRow}->${r.targetTableId}#${targetRow}`;
      return { r, src, sourceRow, targetRow, srcCol, anchorKey };
    });
    const anchorCounts = new Map<string, number>();
    for (const p of prepared) {
      if (!p) continue;
      anchorCounts.set(p.anchorKey, (anchorCounts.get(p.anchorKey) ?? 0) + 1);
    }
    const anchorSeen = new Map<string, number>();
    const out: RelationEdgeType[] = [];
    for (const p of prepared) {
      if (!p) continue;
      const { r, src, sourceRow, targetRow, srcCol, anchorKey } = p;
      const siblingIndex = anchorSeen.get(anchorKey) ?? 0;
      anchorSeen.set(anchorKey, siblingIndex + 1);
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
          siblingIndex,
          siblingCount: anchorCounts.get(anchorKey) ?? 1,
        },
      });
    }
    return out;
  }, [diagram.relationships, tableMap, selection.relationshipId, tracing, traceRels, selectedTableId]);

  /* ---------- change handlers ---------- */

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moves: { id: string; position: { x: number; y: number } }[] = [];
      const removedTables: string[] = [];
      const removedNotes: string[] = [];
      let nextTables: string[] | null = null;
      let nextNote: string | null | undefined;
      const noteMap = new Set(diagram.notes.map((n) => n.id));
      for (const ch of changes) {
        switch (ch.type) {
          case 'position':
            if (ch.position) moves.push({ id: ch.id, position: ch.position });
            break;
          case 'dimensions':
            if (ch.dimensions) {
              if (ch.setAttributes && noteMap.has(ch.id)) {
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
          case 'select': {
            if (noteMap.has(ch.id)) {
              nextNote = ch.selected ? ch.id : nextNote === ch.id ? null : (nextNote ?? null);
              if (!ch.selected && selection.noteId === ch.id) nextNote = null;
            } else {
              if (nextTables === null) nextTables = [...selection.tableIds];
              if (ch.selected && !nextTables.includes(ch.id)) nextTables.push(ch.id);
              if (!ch.selected) nextTables = nextTables.filter((x) => x !== ch.id);
            }
            break;
          }
          case 'remove':
            if (noteMap.has(ch.id)) removedNotes.push(ch.id);
            else removedTables.push(ch.id);
            break;
          default:
            break;
        }
      }
      if (moves.length) moveItems(moves);
      if (nextTables !== null || nextNote !== undefined) {
        const patch: Partial<typeof selection> = {};
        if (nextTables !== null) patch.tableIds = nextTables;
        if (nextNote !== undefined) patch.noteId = nextNote;
        if ((nextTables && nextTables.length) || nextNote) patch.relationshipId = null;
        setSelection(patch);
      }
      if (removedTables.length) deleteTables(removedTables);
      for (const id of removedNotes) deleteNote(id);
    },
    [diagram.notes, selection, moveItems, mutate, setNodeSize, setSelection, deleteTables, deleteNote],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      for (const ch of changes) {
        if (ch.type === 'select') {
          if (ch.selected) setSelection({ relationshipId: ch.id, tableIds: [], noteId: null });
          else if (selection.relationshipId === ch.id) setSelection({ relationshipId: null });
        } else if (ch.type === 'remove') {
          if (diagram.relationships.some((r) => r.id === ch.id)) deleteRelationship(ch.id);
        }
      }
    },
    [selection.relationshipId, diagram.relationships, setSelection, deleteRelationship],
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
          setSelection({ relationshipId: dup.id, tableIds: [], noteId: null });
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
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={() => setInspectorOpen(true)}
        onNodeDragStart={beginDrag}
        onNodeDragStop={endDrag}
        onSelectionDragStart={beginDrag}
        onSelectionDragStop={endDrag}
        onPaneClick={() => clearSelection()}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={24}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        selectionKeyCode="Shift"
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

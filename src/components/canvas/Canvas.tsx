import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { GROUP_STICKINESS, groupAtPoint, groupBounds, inflate, rectCenter, rectContains, tableRect, type Rect } from '@/lib/groups';
import { TableNode, HEADER_HANDLE_SUFFIX, type TableNodeType } from './TableNode';
import { NoteNode, type NoteNodeType } from './NoteNode';
import { GroupNode, GROUP_DRAG_HANDLE, type GroupNodeType } from './GroupNode';
import { RelationEdge, type RelationEdgeType } from './RelationEdge';

const nodeTypes = { table: TableNode, note: NoteNode, tablegroup: GroupNode };
const edgeTypes = { relation: RelationEdge };

type CanvasNode = TableNodeType | NoteNodeType | GroupNodeType;

/**
 * What is currently being dragged. Regions are sized from where their tables
 * sit, so while a table is in flight we hold its group's box still (computed
 * without it) instead of letting the region stretch after the cursor.
 */
interface DragState {
  kind: 'tables' | 'group';
  /** Dragged table ids, or the members of the dragged group. */
  ids: string[];
  /** Positions at the moment the drag started, so moves stay absolute. */
  startPositions: Record<string, { x: number; y: number }>;
  /** Group being dragged, plus where its box started. */
  groupId?: string;
  groupStart?: { x: number; y: number };
  /** Region boxes as they were before the drag, for groups left empty by it. */
  boundsAtStart: Record<string, Rect>;
}

function parseHandle(handle: string | null | undefined): { kind: 'column'; columnId: string } | { kind: 'header'; ownerId: string } | null {
  if (!handle) return null;
  if (handle.endsWith(HEADER_HANDLE_SUFFIX)) return { kind: 'header', ownerId: handle.slice(0, -HEADER_HANDLE_SUFFIX.length) };
  const i = handle.lastIndexOf('|');
  if (i === -1) return null;
  return { kind: 'column', columnId: handle.slice(0, i) };
}

/**
 * Which region a table belongs in after a drag. Another group's region wins
 * outright; its own region keeps it unless it was dragged clearly outside,
 * so nudging a table at the edge does not silently drop it out of the group.
 */
function resolveGroup(bounds: Record<string, Rect>, center: { x: number; y: number }, currentGroupId: string | undefined): string | null {
  const others = Object.fromEntries(Object.entries(bounds).filter(([id]) => id !== currentGroupId));
  const hit = groupAtPoint(others, center);
  if (hit) return hit;
  const own = currentGroupId ? bounds[currentGroupId] : undefined;
  if (own && rectContains(inflate(own, GROUP_STICKINESS), center)) return currentGroupId ?? null;
  return null;
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
  const moveGroup = useStore((s) => s.moveGroup);
  const selectGroup = useStore((s) => s.selectGroup);

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

  /* ---------- group regions ---------- */

  const groupIds = useMemo(() => new Set(diagram.groups.map((g) => g.id)), [diagram.groups]);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const bounds = useMemo(
    () =>
      groupBounds(diagram, {
        sizes: nodeSizes,
        // While tables are in flight their region holds still, so you can see
        // whether you are dropping them inside it or outside it.
        exclude: drag?.kind === 'tables' ? new Set(drag.ids) : undefined,
        fallback: drag?.boundsAtStart,
      }),
    [diagram, nodeSizes, drag],
  );

  const groupTableCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of diagram.tables) if (t.groupId) counts[t.groupId] = (counts[t.groupId] ?? 0) + 1;
    return counts;
  }, [diagram.tables]);

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
    // Regions render behind the edges, and let clicks through everywhere except
    // their title bar, so the canvas underneath keeps working normally.
    const groupNodes: GroupNodeType[] = diagram.groups.map((g) => {
      const box = bounds[g.id];
      return {
        id: g.id,
        type: 'tablegroup',
        position: { x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        data: {
          group: g,
          tableCount: groupTableCounts[g.id] ?? 0,
          selected: selection.groupId === g.id,
          dimmed: tracing,
          dropTarget: dropTargetId === g.id,
        },
        selectable: false,
        deletable: false,
        dragHandle: GROUP_DRAG_HANDLE,
        zIndex: -1,
        style: { pointerEvents: 'none' },
      };
    });
    return [...groupNodes, ...noteNodes, ...tableNodes];
  }, [
    diagram.tables,
    diagram.notes,
    diagram.groups,
    selection.tableIds,
    selection.noteId,
    selection.groupId,
    nodeSizes,
    trace.result,
    trace.picking,
    traceTables,
    tracing,
    fkColumnsByTable,
    bounds,
    groupTableCounts,
    dropTargetId,
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

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moves: { id: string; position: { x: number; y: number } }[] = [];
      const removedTables: string[] = [];
      const removedNotes: string[] = [];
      let nextTables: string[] | null = null;
      let nextNote: string | null | undefined;
      const noteMap = new Set(diagram.notes.map((n) => n.id));
      for (const ch of changes) {
        // A region's rectangle is derived from its tables, so React Flow's own
        // position and size changes for it are noise; onNodeDrag moves the
        // member tables instead.
        if ('id' in ch && groupIds.has(ch.id)) continue;
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
    [diagram.notes, groupIds, selection, moveItems, mutate, setNodeSize, setSelection, deleteTables, deleteNote],
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

  /* ---------- dragging tables and regions ---------- */

  const onNodeDragStart = useCallback(
    (_e: MouseEvent | TouchEvent, node: Node, dragged: Node[]) => {
      beginDrag();
      const d = useStore.getState().diagram;
      const boundsAtStart = groupBounds(d, { sizes: nodeSizes });
      let state: DragState;
      if (node.type === 'tablegroup') {
        const members = d.tables.filter((t) => t.groupId === node.id);
        state = {
          kind: 'group',
          ids: members.map((t) => t.id),
          startPositions: Object.fromEntries(members.map((t) => [t.id, { ...t.position }])),
          groupId: node.id,
          groupStart: { ...node.position },
          boundsAtStart,
        };
        selectGroup(node.id);
      } else {
        const tables = (dragged.length ? dragged : [node]).filter((n) => n.type === 'table');
        state = {
          kind: 'tables',
          ids: tables.map((n) => n.id),
          startPositions: Object.fromEntries(tables.map((n) => [n.id, { ...n.position }])),
          boundsAtStart,
        };
      }
      dragRef.current = state;
      setDrag(state);
    },
    [beginDrag, nodeSizes, selectGroup],
  );

  const onNodeDrag = useCallback(
    (_e: MouseEvent | TouchEvent, node: Node) => {
      const state = dragRef.current;
      if (!state) return;
      if (state.kind === 'group') {
        if (node.id !== state.groupId || !state.groupStart) return;
        // Absolute, not incremental: a dropped frame can never accumulate drift.
        const dx = node.position.x - state.groupStart.x;
        const dy = node.position.y - state.groupStart.y;
        moveItems(state.ids.map((id) => ({ id, position: { x: state.startPositions[id].x + dx, y: state.startPositions[id].y + dy } })));
        return;
      }
      if (node.type !== 'table' || diagram.groups.length === 0) return;
      const t = tableMap.get(node.id);
      if (!t) return;
      const size = tableRect(t, nodeSizes);
      const center = rectCenter({ x: node.position.x, y: node.position.y, width: size.width, height: size.height });
      setDropTargetId(resolveGroup(bounds, center, t.groupId));
    },
    [moveItems, diagram.groups.length, tableMap, nodeSizes, bounds],
  );

  const onNodeDragStop = useCallback(() => {
    const state = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    setDropTargetId(null);

    if (state && diagram.groups.length) {
      const d = useStore.getState().diagram;
      if (state.kind === 'group' && state.groupId) {
        // Keep the fallback anchor under the region, so emptying it later does
        // not teleport the box back to where it was first created.
        const box = groupBounds(d, { sizes: nodeSizes })[state.groupId];
        if (box) moveGroup(state.groupId, [], { x: Math.round(box.x), y: Math.round(box.y) });
      } else if (state.kind === 'tables') {
        const dropped = groupBounds(d, { sizes: nodeSizes, exclude: new Set(state.ids), fallback: state.boundsAtStart });
        const moves: { id: string; groupId: string | undefined }[] = [];
        for (const id of state.ids) {
          const t = d.tables.find((x) => x.id === id);
          if (!t) continue;
          const target = resolveGroup(dropped, rectCenter(tableRect(t, nodeSizes)), t.groupId);
          if ((t.groupId ?? null) !== target) moves.push({ id, groupId: target ?? undefined });
        }
        if (moves.length) {
          // Same history step as the move itself: one undo puts everything back.
          mutate(
            (dd) => {
              for (const m of moves) {
                const t = dd.tables.find((x) => x.id === m.id);
                if (t) t.groupId = m.groupId;
              }
            },
            { history: false },
          );
        }
      }
    }
    endDrag();
  }, [diagram.groups.length, nodeSizes, moveGroup, mutate, endDrag]);

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (node.type === 'tablegroup') {
        selectGroup(node.id);
        return;
      }
      if (!trace.picking || node.type !== 'table') return;
      if (!trace.fromId) {
        setTraceEndpoints(node.id, null);
      } else if (node.id !== trace.fromId) {
        setTraceEndpoints(trace.fromId, node.id);
        // runTrace reads the store synchronously after the update above
        setTimeout(() => runTrace(), 0);
      }
    },
    [trace.picking, trace.fromId, setTraceEndpoints, runTrace, selectGroup],
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
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
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
          nodeColor={(n) => {
            if (n.type === 'table') return paletteHue((n.data as { table: { color: string } }).table.color);
            if (n.type === 'tablegroup') return 'var(--minimap-group)';
            return 'var(--flow)';
          }}
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

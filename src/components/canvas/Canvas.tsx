import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useUi } from '@/store/useUi';
import { useSimulation } from '@/store/useSimulation';
import { rowsAtStage } from '@/lib/simulate/engine';
import { isContextMenuOpen, openContextMenu } from '@/components/ui/ContextMenu';
import type { SelectionChange } from '@/lib/selection';
import { paletteHue } from '@/lib/palette';
import { GROUP_STICKINESS, groupAtPoint, groupBounds, inflate, rectCenter, rectContains, tableRect, type Rect } from '@/lib/groups';
import { effectiveDisplay, visibleColumns } from '@/lib/visibleColumns';
import { isJoinTable, relationshipCardinality } from '@/lib/schemaInfo';
import { reachableTables } from '@/lib/trace';
import { copySelectionToClipboard, cutSelection, openDroppedFiles, pasteText } from '@/lib/canvasActions';
import { TableNode, HEADER_HANDLE_SUFFIX, type TableNodeType } from './TableNode';
import { NoteNode, type NoteNodeType } from './NoteNode';
import { GroupNode, GROUP_DRAG_HANDLE, type GroupNodeType } from './GroupNode';
import { RelationEdge, type RelationEdgeData, type RelationEdgeType } from './RelationEdge';
import { FocusBanner, MAX_FOCUS_HOPS } from './FocusBanner';
import { SimulationBanner } from './SimulationBanner';
import { DropOverlay } from './DropOverlay';
import '@/styles/canvas-extras.css';

/** Below this zoom every table collapses to its header so a big schema stays legible. */
const LOD_ZOOM = 0.35;

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

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
  const moveGroup = useStore((s) => s.moveGroup);
  const selectGroup = useStore((s) => s.selectGroup);
  const viewportNonce = useStore((s) => s.viewportNonce);
  const setViewportInStore = useStore((s) => s.setViewport);
  const nudgeSelection = useStore((s) => s.nudgeSelection);

  const simResult = useSimulation((s) => s.result);
  const simStage = useSimulation((s) => s.stage);
  const simNonce = useSimulation((s) => s.nonce);
  const simPlaying = useSimulation((s) => s.playing);

  const focus = useUi((s) => s.focus);
  const snapToGrid = useUi((s) => s.snapToGrid);
  const showCardinality = useUi((s) => s.showCardinality);
  const lodCollapsed = useUi((s) => s.lodCollapsed);
  const setLodCollapsed = useUi((s) => s.setLodCollapsed);
  const renamingTableId = useUi((s) => s.renamingTableId);
  const setRenamingTableId = useUi((s) => s.setRenamingTableId);

  const { fitView, screenToFlowPosition, setViewport, setCenter, getViewport } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
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

  /* ---------- data-flow simulation ---------- */

  // Which tables and connections take part, and what the stage in play touches.
  const simulating = simResult !== null;
  const simTables = useMemo(() => new Set(simResult?.tableIds ?? []), [simResult]);
  const simCurrent = simResult && simStage >= 0 ? simResult.stages[simStage] : null;
  const simFlowIndex = useMemo(() => new Map((simResult?.flowIds ?? []).map((id, i) => [id, i])), [simResult]);
  const simLookupRels = useMemo(() => new Set(simCurrent?.lookupRelationshipIds ?? []), [simCurrent]);
  const simActiveTables = useMemo(
    () => new Set(simCurrent ? [simCurrent.sourceTableId, simCurrent.targetTableId, ...simCurrent.lookupTableIds] : []),
    [simCurrent],
  );

  /* ---------- collapse modes, focus, cardinality ---------- */

  const shownColumns = useMemo(() => {
    const m = new Map<string, ReturnType<typeof visibleColumns>>();
    for (const t of diagram.tables) m.set(t.id, visibleColumns(t, effectiveDisplay(t, lodCollapsed), new Set(fkColumnsByTable.get(t.id) ?? [])));
    return m;
  }, [diagram.tables, fkColumnsByTable, lodCollapsed]);

  // Neighborhood focus: tables within N hops of the focused one; a trace or a simulation wins while it is active.
  const focusSet = useMemo(() => {
    if (!focus || tracing || simulating || !tableMap.has(focus.tableId)) return null;
    const dist = reachableTables(diagram, focus.tableId);
    return new Set([...dist.entries()].filter(([, d]) => d <= focus.hops).map(([id]) => id));
  }, [focus, tracing, diagram, tableMap]);

  const joinTables = useMemo(() => new Set(diagram.tables.filter((t) => isJoinTable(diagram, t)).map((t) => t.id)), [diagram]);

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
          visibleColumns: shownColumns.get(t.id) ?? t.columns,
          display: effectiveDisplay(t, lodCollapsed),
          lod: lodCollapsed,
          joinTable: joinTables.has(t.id),
          dimmed: (tracing && !traceTables.has(t.id)) || (focusSet !== null && !focusSet.has(t.id)) || (simulating && !simTables.has(t.id)),
          traceRole: role,
          picking: trace.picking,
          renaming: renamingTableId === t.id,
          simulation:
            simResult && simTables.has(t.id)
              ? {
                  role: simResult.roles[t.id] ?? 'input',
                  rowCount: rowsAtStage(simResult, t.id, simStage),
                  active: simActiveTables.has(t.id),
                  isTarget: t.id === simResult.targetId,
                  readColumnIds: simCurrent ? simCurrent.reads.filter((r) => r.tableId === t.id).map((r) => r.columnId) : [],
                  writtenColumnIds: simCurrent && simCurrent.targetTableId === t.id ? simCurrent.writes : [],
                }
              : null,
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
      data: { note: n, dimmed: tracing || simulating || focusSet !== null },
      selected: selection.noteIds.includes(n.id),
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
          dimmed: tracing || simulating || focusSet !== null,
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
    selection.noteIds,
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
    embedColumnsByTable,
    shownColumns,
    lodCollapsed,
    joinTables,
    focusSet,
    renamingTableId,
    simResult,
    simStage,
    simTables,
    simActiveTables,
    simCurrent,
    simulating,
  ]);

  const edges = useMemo<RelationEdgeType[]>(() => {
    const prepared = diagram.relationships.map((r) => {
      const src = tableMap.get(r.sourceTableId);
      const tgt = tableMap.get(r.targetTableId);
      if (!src || !tgt) return null;
      // Rows are indexes into the columns actually drawn; a hidden column anchors the edge at the header.
      const srcShown = shownColumns.get(src.id) ?? src.columns;
      const tgtShown = shownColumns.get(tgt.id) ?? tgt.columns;
      const sourceRow = r.sourceColumnIds.length ? srcShown.findIndex((c) => c.id === r.sourceColumnIds[0]) : -1;
      const targetRow = r.targetColumnIds.length ? tgtShown.findIndex((c) => c.id === r.targetColumnIds[0]) : -1;
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
      const card = showCardinality && r.kind === 'fk' ? relationshipCardinality(diagram, r) : null;
      const inFocus = focusSet === null || (focusSet.has(r.sourceTableId) && focusSet.has(r.targetTableId));
      // A flow in the simulation is pending, in play or done; a foreign key the
      // stage in play reads through is a lookup; everything else fades.
      let simulation: RelationEdgeData['simulation'] = null;
      if (simResult) {
        const idx = simFlowIndex.get(r.id);
        if (idx !== undefined) {
          const stage = simResult.stages[idx];
          const produced = stage.producedRange[1] - stage.producedRange[0];
          simulation = {
            state: idx < simStage ? 'done' : idx === simStage ? 'active' : 'pending',
            packets: Math.min(12, Math.max(produced > 0 ? 1 : 0, produced)),
            nonce: simNonce,
            loop: !simPlaying,
          };
        } else if (simLookupRels.has(r.id)) simulation = { state: 'lookup', packets: 0, nonce: simNonce, loop: false };
      }
      const simDim = simulating && simulation === null;
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
          dimmed: (tracing && !traceRels.has(r.id)) || !inFocus || simDim,
          traced: traceRels.has(r.id),
          simulation,
          attached: selectedTableId !== null && (r.sourceTableId === selectedTableId || r.targetTableId === selectedTableId),
          optional: r.kind === 'fk' && Boolean(srcCol?.nullable),
          siblingIndex,
          siblingCount: anchorCounts.get(anchorKey) ?? 1,
          cardinality: card ? { source: card.source === 'N' ? (card.sourceOptional ? '0..N' : 'N') : card.sourceOptional ? '0..1' : '1', target: '1' } : null,
        },
      });
    }
    return out;
  }, [diagram, tableMap, selection.relationshipId, tracing, traceRels, selectedTableId, shownColumns, showCardinality, focusSet, simResult, simFlowIndex, simStage, simNonce, simPlaying, simLookupRels, simulating]);

  /* ---------- change handlers ---------- */

  const noteIds = useMemo(() => new Set(diagram.notes.map((n) => n.id)), [diagram.notes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moves: { id: string; position: { x: number; y: number } }[] = [];
      const selects: SelectionChange[] = [];
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
    [noteIds, groupIds, moveItems, mutate, setNodeSize, applyNodeSelection],
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
      const touchesView = tableMap.get(c.source)?.kind === 'view' || tableMap.get(c.target)?.kind === 'view';
      if (touchesView && a.kind === 'column' && b.kind === 'column') {
        toast('info', 'Views cannot have foreign keys; a data-flow link was added instead.');
      }
      if (a.kind === 'column' && b.kind === 'column' && !touchesView) {
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
    [diagram.relationships, addRelationship, toast, setSelection, tableMap],
  );

  /* ---------- dragging tables and regions ---------- */

  /** Start of a table drag, whether by one node or by the marquee rectangle. */
  const startTableDrag = useCallback(
    (dragged: Node[]) => {
      const d = useStore.getState().diagram;
      const tables = dragged.filter((n) => n.type === 'table');
      const state: DragState = {
        kind: 'tables',
        ids: tables.map((n) => n.id),
        startPositions: Object.fromEntries(tables.map((n) => [n.id, { ...n.position }])),
        boundsAtStart: groupBounds(d, { sizes: nodeSizes }),
      };
      dragRef.current = state;
      setDrag(state);
    },
    [nodeSizes],
  );

  /** Highlights the region a dragged table would land in. */
  const updateDropTarget = useCallback(
    (node: Node) => {
      if (node.type !== 'table' || diagram.groups.length === 0) return;
      const t = tableMap.get(node.id);
      if (!t) return;
      const size = tableRect(t, nodeSizes);
      const center = rectCenter({ x: node.position.x, y: node.position.y, width: size.width, height: size.height });
      setDropTargetId(resolveGroup(bounds, center, t.groupId));
    },
    [diagram.groups.length, tableMap, nodeSizes, bounds],
  );

  const onNodeDragStart = useCallback(
    (_e: MouseEvent | TouchEvent, node: Node, dragged: Node[]) => {
      beginDrag();
      if (node.type !== 'tablegroup') {
        startTableDrag(dragged.length ? dragged : [node]);
        return;
      }
      const d = useStore.getState().diagram;
      const boundsAtStart = groupBounds(d, { sizes: nodeSizes });
      {
        const members = d.tables.filter((t) => t.groupId === node.id);
        const state: DragState = {
          kind: 'group',
          ids: members.map((t) => t.id),
          startPositions: Object.fromEntries(members.map((t) => [t.id, { ...t.position }])),
          groupId: node.id,
          groupStart: { ...node.position },
          boundsAtStart,
        };
        dragRef.current = state;
        setDrag(state);
        selectGroup(node.id);
      }
    },
    [beginDrag, nodeSizes, selectGroup, startTableDrag],
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
      updateDropTarget(node);
    },
    [moveItems, updateDropTarget],
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

  /**
   * Dragging the marquee rectangle reports through the selection callbacks
   * instead of the node ones, so it has to run the same membership pass or a
   * boxed group of tables would move without ever joining or leaving a region.
   */
  const onSelectionDragStart = useCallback(
    (_e: React.MouseEvent, dragged: Node[]) => {
      beginDrag();
      startTableDrag(dragged);
    },
    [beginDrag, startTableDrag],
  );

  const onSelectionDrag = useCallback(
    (_e: React.MouseEvent, dragged: Node[]) => {
      const first = dragged.find((n) => n.type === 'table');
      if (first) updateDropTarget(first);
    },
    [updateDropTarget],
  );

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

  /* ---------- right-click menus ---------- */

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      openContextMenu(e, { type: 'pane', flowPosition: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
    },
    [screenToFlowPosition],
  );

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      // A region is a node too, but it is not a table: give it its own menu
      // rather than letting it fall through and act on a table id that does
      // not exist.
      if (node.type === 'tablegroup') {
        selectGroup(node.id);
        openContextMenu(e, { type: 'group', groupId: node.id });
        return;
      }
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
    [selection.tableIds, selection.noteIds, setSelection, selectGroup],
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
    // fitView's zoom is set by how much space the node set needs, so with a
    // few neighbors in the mix it usually lands well under maxZoom and the
    // cap never kicks in — raising it did nothing. Force the zoom instead of
    // fitting to a bounding box, so a click always lands at the same close level.
    const t = tableMap.get(focusTableId);
    if (t) {
      const center = rectCenter(tableRect(t, nodeSizes));
      void setCenter(center.x, center.y, { zoom: 1.75, duration: 500 });
    }
    focusTable(null);
  }, [focusTableId, tableMap, nodeSizes, setCenter, focusTable]);

  // Starting a simulation frames every table that takes part.
  const simKey = simResult ? `${simResult.targetId}:${simResult.tableIds.join(',')}` : '';
  useEffect(() => {
    if (!simKey) return;
    const ids = simKey.slice(simKey.indexOf(':') + 1).split(',').filter(Boolean);
    const t = setTimeout(() => fitView({ nodes: ids.map((id) => ({ id })), duration: 500, padding: 0.25, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
  }, [simKey, fitView]);

  // A diagram that carried a saved viewport reopens where it was left.
  useEffect(() => {
    if (viewportNonce === 0) return;
    const v = useStore.getState().diagram.viewport;
    if (v) void setViewport(v, { duration: 0 });
  }, [viewportNonce, setViewport]);

  // Entering focus mode frames the neighborhood.
  const focusKey = focus ? `${focus.tableId}:${focus.hops}` : '';
  useEffect(() => {
    if (!focusSet || !focusKey) return;
    const t = setTimeout(() => fitView({ nodes: [...focusSet].map((id) => ({ id })), duration: 400, padding: 0.3, maxZoom: 1.1 }), 40);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, fitView]);

  const lodFrame = useRef<number | null>(null);
  const onMove = useCallback(() => {
    if (lodFrame.current !== null) return;
    lodFrame.current = requestAnimationFrame(() => {
      lodFrame.current = null;
      setLodCollapsed(getViewport().zoom < LOD_ZOOM);
    });
  }, [getViewport, setLodCollapsed]);
  const onMoveEnd = useCallback(() => {
    const v = getViewport();
    setViewportInStore({ x: Math.round(v.x), y: Math.round(v.y), zoom: Number(v.zoom.toFixed(3)) });
  }, [getViewport, setViewportInStore]);

  /* ---------- keyboard: nudge, focus, rename ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target) || isContextMenuOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = useStore.getState();
      const ui = useUi.getState();
      if (e.key.startsWith('Arrow')) {
        if (!s.selection.tableIds.length && !s.selection.noteIds.length) return;
        const step = e.shiftKey ? 50 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        e.preventDefault();
        nudgeSelection(dx, dy);
        return;
      }
      if (e.key === '.' && s.selection.tableIds.length === 1) {
        e.preventDefault();
        const id = s.selection.tableIds[0];
        ui.setFocus(ui.focus?.tableId === id ? null : { tableId: id, hops: 1 });
        return;
      }
      if ((e.key === '[' || e.key === ']') && ui.focus) {
        e.preventDefault();
        const hops = Math.max(1, Math.min(MAX_FOCUS_HOPS, ui.focus.hops + (e.key === ']' ? 1 : -1)));
        ui.setFocus({ tableId: ui.focus.tableId, hops });
        return;
      }
      if (e.key === 'F2' && s.selection.tableIds.length === 1) {
        e.preventDefault();
        ui.setRenamingTableId(s.selection.tableIds[0]);
        return;
      }
      if (e.key === 'Escape' && ui.focus && !s.trace.picking && !s.trace.result) {
        ui.setFocus(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudgeSelection]);

  /* ---------- copy / cut / paste ---------- */

  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (isEditable(e.target) || !useStore.getState().selection.tableIds.length) return;
      e.preventDefault();
      void copySelectionToClipboard();
    };
    const onCut = (e: ClipboardEvent) => {
      if (isEditable(e.target) || !useStore.getState().selection.tableIds.length) return;
      e.preventDefault();
      cutSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target)) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      const kind = pasteText(text);
      if (kind !== 'unknown') e.preventDefault();
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

  /* ---------- file drop ---------- */

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDropping(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const files = Array.from(e.dataTransfer.files);
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    void openDroppedFiles(files, { x: Math.round(at.x), y: Math.round(at.y) });
  };

  const pickingLabel = trace.picking ? (trace.fromId ? `From ${tableMap.get(trace.fromId)?.name ?? '?'}: now click the destination table` : 'Click the starting table') : null;

  return (
    <div ref={wrapperRef} className="app__canvas" onDoubleClick={onPaneDoubleClick} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
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
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onSelectionDragStart={onSelectionDragStart}
        onSelectionDrag={onSelectionDrag}
        onSelectionDragStop={onNodeDragStop}
        onSelectionStart={() => void (boxSelecting.current = true)}
        onSelectionEnd={() => void (boxSelecting.current = false)}
        onPaneClick={() => {
          clearSelection();
          if (renamingTableId) setRenamingTableId(null);
        }}
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        snapToGrid={snapToGrid}
        snapGrid={[20, 20]}
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
          nodeColor={(n) => {
            if (n.type === 'table') return paletteHue((n.data as { table: { color: string } }).table.color);
            if (n.type === 'tablegroup') return 'var(--minimap-group)';
            return 'var(--flow)';
          }}
          nodeStrokeWidth={0}
          maskColor="rgba(0,0,0,0.25)"
        />
      </ReactFlow>
      {!pickingLabel && !simulating && <FocusBanner />}
      {!pickingLabel && <SimulationBanner />}
      <DropOverlay visible={dropping} />
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

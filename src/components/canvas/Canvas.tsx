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
import { isCodeStepOp, type Program } from '@shared/types';
import { selectDiagramContent, selectEmphasis, useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { useSimulation } from '@/store/useSimulation';
import { rowsAtStage } from '@/lib/simulate/engine';
import { isContextMenuOpen, openContextMenu } from '@/components/ui/ContextMenu';
import type { SelectionChange } from '@/lib/selection';
import { paletteHue } from '@/lib/palette';
import { isBlankDiagram, showsStartScreen } from '@/lib/emphasis';
import { StartPanel } from './StartPanel';
import { GROUP_STICKINESS, groupAtPoint, groupBounds, inflate, rectCenter, rectContains, tableRect, type Rect } from '@/lib/groups';
import { estimateProgramSize, programRoundTrips } from '@/lib/programs';
import {
  canBeParentOf,
  codeBounds,
  codeContainerAtPoint,
  codeDepth,
  codeDescendantIds,
  codePath,
  codeSubtreeIds,
  codeVisibility,
  drawnCodeEdges,
  drawnTableLinks,
  type CodeVisibility,
} from '@/lib/codemap';
import { effectiveDisplay, visibleColumns } from '@/lib/visibleColumns';
import { isJoinTable, relationshipCardinality } from '@/lib/schemaInfo';
import { buildLineage, derivedColumnIds, describeColumnOrigin, downstream, lineageReach, upstream } from '@/lib/lineage';
import { reachableNodes } from '@/lib/trace';
import { copiedMessage, cutSelection, openDroppedFiles, pasteFromEvent, writeSelectionToEvent } from '@/lib/canvasActions';
import { reuseUnchanged } from '@/lib/stableList';
import { TableNode, HEADER_HANDLE_SUFFIX, type TableNodeType } from './TableNode';
import { NoteNode, type NoteNodeType } from './NoteNode';
import { GroupNode, GROUP_DRAG_HANDLE, type GroupNodeType } from './GroupNode';
import { RelationEdge, type RelationEdgeData, type RelationEdgeType } from './RelationEdge';
import { ProgramNode, type ProgramNodeType, type ProgramStepView } from './ProgramNode';
import { ProgramEdge, type ProgramEdgeType } from './ProgramEdge';
import { CodeGroupNode, CODE_GROUP_DRAG_HANDLE, type CodeGroupNodeType } from './CodeGroupNode';
import { CodeEdge, type CodeEdgeType } from './CodeEdge';
import { FocusBanner, MAX_FOCUS_HOPS } from './FocusBanner';
import { SimulationBanner } from './SimulationBanner';
import { DerivedBanner } from './DerivedBanner';
import { DropOverlay } from './DropOverlay';
import '@/styles/canvas-extras.css';

/** Below this zoom every table collapses to its header so a big schema stays legible. */
const LOD_ZOOM = 0.35;

/**
 * The derived list with every unchanged item kept as the object React Flow
 * already holds, so only what actually changed is re-adopted and re-rendered.
 * See lib/stableList for why this matters on a big diagram.
 */
function useStableList<T extends { id: string }>(next: T[]): T[] {
  const last = useRef<T[] | null>(null);
  const stable = useMemo(() => reuseUnchanged(last.current, next), [next]);
  last.current = stable;
  return stable;
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const nodeTypes = { table: TableNode, note: NoteNode, tablegroup: GroupNode, program: ProgramNode, codegroup: CodeGroupNode };
const edgeTypes = { relation: RelationEdge, programlink: ProgramEdge, codelink: CodeEdge };

type CanvasNode = TableNodeType | NoteNodeType | GroupNodeType | ProgramNodeType | CodeGroupNodeType;
type CanvasEdge = RelationEdgeType | ProgramEdgeType | CodeEdgeType;

/**
 * What is currently being dragged. Regions are sized from where their members
 * sit, so while a table or a code node is in flight we hold its container's
 * box still (computed without it) instead of letting the region stretch after
 * the cursor. A dragged region moves its members instead.
 */
interface DragState {
  kind: 'nodes' | 'group' | 'codegroup';
  /** Dragged table ids, or the members of the dragged group. */
  ids: string[];
  /** Dragged code node ids, or every node inside the dragged container. */
  codeIds: string[];
  /** Positions at the moment the drag started, so moves stay absolute. */
  startPositions: Record<string, { x: number; y: number }>;
  /** Group or container being dragged, plus where its box started. */
  groupId?: string;
  groupStart?: { x: number; y: number };
  /** Region boxes as they were before the drag, for groups left empty by it. */
  boundsAtStart: Record<string, Rect>;
  codeBoundsAtStart: Record<string, Rect>;
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

/**
 * The same rule for a code node and the container regions, with two extra
 * conditions: a node can never be dropped into itself or into anything inside
 * it, and the kinds have to allow the nesting — a function is never dropped
 * into a function, whatever the pointer says.
 */
function resolveCodeParent(
  d: Parameters<typeof canBeParentOf>[0],
  bounds: Record<string, Rect>,
  node: Program,
  center: { x: number; y: number },
  subtree: ReadonlySet<string>,
): string | null {
  const others = Object.fromEntries(Object.entries(bounds).filter(([id]) => id !== node.parentId));
  const hit = codeContainerAtPoint(others, center, subtree);
  const allowed = (id: string) => {
    const parent = d.programs.find((p) => p.id === id);
    return Boolean(parent && canBeParentOf(d, parent, node));
  };
  if (hit && allowed(hit)) return hit;
  const own = node.parentId ? bounds[node.parentId] : undefined;
  if (own && rectContains(inflate(own, GROUP_STICKINESS), center)) return node.parentId ?? null;
  return null;
}

export function Canvas() {
  const diagram = useStore((s) => s.diagram);
  const selection = useStore((s) => s.selection);
  const trace = useStore((s) => s.trace);
  const nodeSizes = useStore((s) => s.nodeSizes);
  const fitViewNonce = useStore((s) => s.fitViewNonce);
  const focusTableId = useStore((s) => s.focusTableId);
  const focusRelationshipId = useStore((s) => s.focusRelationshipId);
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
  const addProgram = useStore((s) => s.addProgram);
  const emphasis = useStore(selectEmphasis);
  const mutate = useStore((s) => s.mutate);
  const focusTable = useStore((s) => s.focusTable);
  const focusRelationship = useStore((s) => s.focusRelationship);
  const setTraceEndpoints = useStore((s) => s.setTraceEndpoints);
  const setTracePicking = useStore((s) => s.setTracePicking);
  const runTrace = useStore((s) => s.runTrace);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const toast = useStore((s) => s.toast);
  const loadSample = useStore((s) => s.loadSample);
  const openDrawer = useStore((s) => s.openDrawer);
  const moveGroup = useStore((s) => s.moveGroup);
  const moveCodeContainer = useStore((s) => s.moveCodeContainer);
  const setCodeParent = useStore((s) => s.setCodeParent);
  const connectCode = useStore((s) => s.connectCode);
  const connectCodeToTable = useStore((s) => s.connectCodeToTable);
  const selectGroup = useStore((s) => s.selectGroup);
  const viewportNonce = useStore((s) => s.viewportNonce);
  const setViewportInStore = useStore((s) => s.setViewport);
  const nudgeSelection = useStore((s) => s.nudgeSelection);

  const simResult = useSimulation((s) => s.result);
  const simStage = useSimulation((s) => s.stage);
  const simNonce = useSimulation((s) => s.nonce);
  const simPlaying = useSimulation((s) => s.playing);

  const focus = useUi((s) => s.focus);
  const derivedLens = useUi((s) => s.derived);
  const snapToGrid = useUi((s) => s.snapToGrid);
  const showCardinality = useUi((s) => s.showCardinality);
  const lodCollapsed = useUi((s) => s.lodCollapsed);
  const setLodCollapsed = useUi((s) => s.setLodCollapsed);
  const renamingNodeId = useUi((s) => s.renamingNodeId);
  const activeProgramStepId = useUi((s) => s.activeProgramStepId);
  const setRenamingNodeId = useUi((s) => s.setRenamingNodeId);

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
  const codeMap = useMemo(() => new Map(diagram.programs.map((p) => [p.id, p])), [diagram.programs]);
  // What the diagram says, as opposed to where it is drawn: the same object
  // until something other than a position changes. The arrows, the columns a
  // table shows and the lineage marks are all read from it, so a drag — which
  // only moves things — does not re-derive a hundred arrows every frame to find
  // that none of them changed. Anything placed on the canvas reads `diagram`.
  const content = useStore(selectDiagramContent);
  const contentTables = useMemo(() => new Map(content.tables.map((t) => [t.id, t])), [content.tables]);
  const contentCode = useMemo(() => new Map(content.programs.map((p) => [p.id, p])), [content.programs]);
  const linkVis = useMemo(() => codeVisibility(content), [content]);
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

  /* ---------- group regions, and the regions code containers draw ---------- */

  const groupIds = useMemo(() => new Set(diagram.groups.map((g) => g.id)), [diagram.groups]);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const bounds = useMemo(() => {
    // While tables are in flight their regions hold still at their pre-drag
    // boxes: recomputing from the remaining members would shrink a group's
    // box the instant you pick up one of its tables, well before the table
    // has actually left it. Membership (and any resulting shrink or grow) is
    // only decided once the drag ends, in onNodeDragStop.
    if (drag?.kind === 'nodes') return drag.boundsAtStart;
    return groupBounds(diagram, { sizes: nodeSizes, fallback: drag?.boundsAtStart });
  }, [diagram, nodeSizes, drag]);

  // Who stands in for whom once containers are folded, and which containers
  // are drawn open. Everything on the code side reads off this one answer.
  const codeVis = useMemo<CodeVisibility>(() => codeVisibility(diagram), [diagram]);
  const expandedCodeIds = useMemo(() => new Set(codeVis.expanded.map((p) => p.id)), [codeVis]);
  const codeRegions = useMemo(() => {
    if (drag?.kind === 'nodes') return drag.codeBoundsAtStart;
    return codeBounds(diagram, { sizes: nodeSizes, fallback: drag?.codeBoundsAtStart }, codeVis);
  }, [diagram, nodeSizes, drag, codeVis]);
  const codeMemberCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of codeVis.expanded) counts[p.id] = codeDescendantIds(diagram, p.id).length;
    return counts;
  }, [diagram, codeVis]);

  const groupTableCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of diagram.tables) if (t.groupId) counts[t.groupId] = (counts[t.groupId] ?? 0) + 1;
    return counts;
  }, [diagram.tables]);

  const tracing = Boolean(trace.result);
  // The path may run through nodes folded inside a container; on the canvas
  // it is the container that lights up.
  const traceNodes = useMemo(() => new Set((trace.result?.nodeIds ?? []).map((id) => codeVis.standIn.get(id) ?? id)), [trace.result, codeVis]);
  const traceRels = useMemo(() => new Set(trace.result?.relationshipIds ?? []), [trace.result]);
  const traceLinkIds = useMemo(() => new Set((trace.result?.hops ?? []).flatMap((h) => (h.link ? [h.link.link.id] : []))), [trace.result]);
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
    for (const t of content.tables) m.set(t.id, visibleColumns(t, effectiveDisplay(t, lodCollapsed), new Set(fkColumnsByTable.get(t.id) ?? [])));
    return m;
  }, [content.tables, fkColumnsByTable, lodCollapsed]);

  // Neighborhood focus: nodes within N hops of the focused one, tables and
  // code alike; a trace or a simulation wins while it is active.
  const focusSet = useMemo(() => {
    if (!focus || tracing || simulating || (!tableMap.has(focus.nodeId) && !codeMap.has(focus.nodeId))) return null;
    const dist = reachableNodes(content, focus.nodeId);
    return new Set([...dist.entries()].filter(([, d]) => d <= focus.hops).map(([id]) => id));
  }, [focus, tracing, simulating, content, tableMap, codeMap]);
  // The same set as the canvas draws it: a focused function inside a folded module keeps the module lit.
  const focusVisible = useMemo(() => (focusSet ? new Set([...focusSet].map((id) => codeVis.standIn.get(id) ?? id)) : null), [focusSet, codeVis]);

  const joinTables = useMemo(() => new Set(content.tables.filter((t) => isJoinTable(content, t)).map((t) => t.id)), [content]);

  /* ---------- derived columns ---------- */

  // Always computed: the Σ mark on a column is part of reading the diagram, not
  // part of the lens. The lens only adds the source colouring and the dimming.
  const lineage = useMemo(() => buildLineage(content), [content]);
  const derivedColumns = useMemo(() => {
    const m = new Map<string, { ids: string[]; summaries: Record<string, string> }>();
    for (const t of content.tables) {
      const ids = derivedColumnIds(lineage, t);
      const summaries: Record<string, string> = {};
      for (const id of ids) {
        const text = describeColumnOrigin(lineage, id);
        if (text) summaries[id] = text;
      }
      m.set(t.id, { ids, summaries });
    }
    return m;
  }, [content.tables, lineage]);

  /**
   * What one column's chain reaches, when the lens is pointed at a column: the
   * flows that fill it, and (unless that is switched off) the flows that read
   * it. Everything outside the chain steps back so the path is the only thing
   * with colour in it.
   */
  const lensReach = useMemo(() => {
    if (!derivedLens?.columnId) return null;
    const up = lineageReach(upstream(lineage, derivedLens.columnId));
    if (!derivedLens.downstream) return up;
    const down = lineageReach(downstream(lineage, derivedLens.columnId));
    return {
      tableIds: new Set([...up.tableIds, ...down.tableIds]),
      columnIds: new Set([...up.columnIds, ...down.columnIds]),
      relationshipIds: new Set([...up.relationshipIds, ...down.relationshipIds]),
    };
  }, [derivedLens?.columnId, derivedLens?.downstream, lineage]);

  const lensing = derivedLens !== null && !tracing && !simulating;

  const traceRoleOf = useCallback(
    (id: string): 'from' | 'to' | 'via' | null => {
      if (!trace.result) return null;
      const standFrom = codeVis.standIn.get(trace.result.from.id) ?? trace.result.from.id;
      const standTo = codeVis.standIn.get(trace.result.to.id) ?? trace.result.to.id;
      if (id === standFrom) return 'from';
      if (id === standTo) return 'to';
      return traceNodes.has(id) ? 'via' : null;
    },
    [trace.result, traceNodes, codeVis],
  );

  const derivedNodes = useMemo<CanvasNode[]>(() => {
    const tableNodes: TableNodeType[] = diagram.tables.map((t) => {
      return {
        id: t.id,
        type: 'table',
        position: t.position,
        data: {
          table: t,
          fkColumnIds: fkColumnsByTable.get(t.id) ?? [],
          embedColumnIds: embedColumnsByTable.get(t.id) ?? [],
          derivedColumnIds: derivedColumns.get(t.id)?.ids ?? [],
          derivedSummaries: derivedColumns.get(t.id)?.summaries ?? {},
          lens: lensing
            ? {
                sourceColumnIds: lineage.sourceByTable.get(t.id) ?? [],
                lineageColumnIds: lensReach ? t.columns.filter((c) => lensReach.columnIds.has(c.id)).map((c) => c.id) : [],
                focusColumnId: derivedLens?.columnId ?? null,
              }
            : null,
          visibleColumns: shownColumns.get(t.id) ?? t.columns,
          display: effectiveDisplay(t, lodCollapsed),
          lod: lodCollapsed,
          joinTable: joinTables.has(t.id),
          dimmed:
            (tracing && !traceNodes.has(t.id)) ||
            (focusSet !== null && !focusSet.has(t.id)) ||
            (simulating && !simTables.has(t.id)) ||
            (lensing && lensReach !== null && !lensReach.tableIds.has(t.id)),
          traceRole: traceRoleOf(t.id),
          picking: trace.picking,
          renaming: renamingNodeId === t.id,
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
    // An expanded container is a region like a group's, drawn outermost first
    // so a class inside a module paints over the module's box.
    const codeGroupNodes: CodeGroupNodeType[] = [...codeVis.expanded]
      .map((p) => ({ p, depth: codeDepth(diagram, p.id) }))
      .sort((a, b) => a.depth - b.depth)
      .map(({ p, depth }) => {
        const box = codeRegions[p.id];
        const inFocus = focusVisible === null || focusVisible.has(p.id) || codeDescendantIds(diagram, p.id).some((id) => focusSet?.has(id));
        return {
          id: p.id,
          type: 'codegroup' as const,
          position: { x: box.x, y: box.y },
          width: box.width,
          height: box.height,
          data: {
            program: p,
            memberCount: codeMemberCounts[p.id] ?? 0,
            depth,
            selected: selection.programIds.includes(p.id),
            dimmed: (tracing && !traceNodes.has(p.id)) || simulating || lensing || !inFocus,
            dropTarget: dropTargetId === p.id,
            traceRole: traceRoleOf(p.id),
          },
          selectable: false,
          deletable: false,
          dragHandle: CODE_GROUP_DRAG_HANDLE,
          zIndex: -1,
          style: { pointerEvents: 'none' },
        };
      });
    // Leaves and folded containers sit above the regions and below nothing:
    // they are foreground, and a step row has to stay clickable.
    const programNodes: ProgramNodeType[] = codeVis.drawn
      .filter((prg) => !expandedCodeIds.has(prg.id))
      .map((prg) => {
        const steps: ProgramStepView[] = prg.steps.map((s) => {
          const table = s.tableId ? tableMap.get(s.tableId) : undefined;
          const code = s.codeId ? codeMap.get(s.codeId) : undefined;
          const namesTable = s.op === 'read' || s.op === 'write';
          return {
            id: s.id,
            op: s.op,
            target: namesTable ? (table?.name ?? null) : isCodeStepOp(s.op) ? (code?.name ?? null) : null,
            columns: s.columnIds.map((id) => table?.columns.find((c) => c.id === id)?.name).filter((n): n is string => Boolean(n)),
            missing: (namesTable && Boolean(s.tableId) && !table) || (isCodeStepOp(s.op) && Boolean(s.codeId) && !code),
            note: s.note?.trim() ?? '',
            hasCode: Boolean(s.code?.trim()),
          };
        });
        return {
          id: prg.id,
          type: 'program' as const,
          position: prg.position,
          data: {
            program: prg,
            steps,
            roundTrips: programRoundTrips(prg).map((id) => tableMap.get(id)?.name ?? '?'),
            path: codePath(diagram, prg, codeMap),
            hiddenMembers: codeVis.hidden.get(prg.id) ?? 0,
            lod: lodCollapsed,
            // Code takes part in a trace and in focus; a simulation and the
            // lineage lens are about tables, so both push it back like a note.
            dimmed: (tracing && !traceNodes.has(prg.id)) || simulating || lensing || (focusVisible !== null && !focusVisible.has(prg.id)),
            traceRole: traceRoleOf(prg.id),
            picking: trace.picking,
            renaming: renamingNodeId === prg.id,
          },
          selected: selection.programIds.includes(prg.id),
          measured: nodeSizes[prg.id],
        };
      });
    return [...groupNodes, ...codeGroupNodes, ...noteNodes, ...tableNodes, ...programNodes];
  }, [
    diagram,
    tableMap,
    codeMap,
    codeVis,
    expandedCodeIds,
    codeRegions,
    codeMemberCounts,
    selection.tableIds,
    selection.noteIds,
    selection.programIds,
    selection.groupId,
    nodeSizes,
    trace.picking,
    traceNodes,
    traceRoleOf,
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
    focusVisible,
    renamingNodeId,
    simResult,
    simStage,
    simTables,
    simActiveTables,
    simCurrent,
    simulating,
    derivedColumns,
    lineage,
    lensing,
    lensReach,
    derivedLens,
  ]);
  const nodes = useStableList(derivedNodes);

  /**
   * The arrows between code and tables. Derived, never stored: a step that
   * names a table draws one, keyed on the step, so reordering the list
   * renumbers the arrows without anything having to be kept in sync. Once a
   * container is folded the arrows of everything inside it are gathered onto
   * the container, one per table and op, counted rather than numbered.
   */
  const derivedProgramEdges = useMemo<ProgramEdgeType[]>(() => {
    if (!content.programs.length) return [];
    const known = new Set(content.tables.map((t) => t.id));
    const selected = new Set(selection.programIds);
    const roundTripKeys = new Set<string>();
    for (const prg of content.programs) for (const id of programRoundTrips(prg)) roundTripKeys.add(`${prg.id}|${id}`);
    return drawnTableLinks(content, linkVis, known).map((edge) => {
      const table = contentTables.get(edge.tableId);
      const shown = table ? (shownColumns.get(table.id) ?? table.columns) : [];
      const first = edge.links[0];
      const columnIds = [...new Set(edge.links.flatMap((l) => l.columnIds))];
      // Anchor on the first named column when it is actually drawn; otherwise
      // meet the header, exactly as a relationship does.
      const tableRow = columnIds.length ? shown.findIndex((c) => c.id === columnIds[0]) : -1;
      const stepIndex = edge.direct ? (contentCode.get(edge.nodeId)?.steps ?? []).findIndex((s) => s.id === first.stepId) : -1;
      const inFocus = focusSet === null || (focusSet.has(edge.tableId) && edge.links.some((l) => focusSet.has(l.programId)));
      const traced = edge.links.some((l) => traceLinkIds.has(l.id));
      return {
        id: edge.id,
        type: 'programlink' as const,
        source: edge.nodeId,
        target: edge.tableId,
        // The step is the thing you delete, not the arrow, so the arrow refuses
        // to be selected or deleted on its own.
        selectable: false,
        deletable: false,
        data: {
          step: edge.direct ? first.step : null,
          count: edge.links.length,
          op: edge.op,
          stepId: edge.direct ? first.stepId : null,
          stepIndex,
          tableRow,
          columns: columnIds.map((id) => table?.columns.find((c) => c.id === id)?.name).filter((n): n is string => Boolean(n)),
          dimmed: (tracing && !traced) || simulating || lensing || !inFocus,
          highlighted: selected.has(edge.nodeId) || edge.links.some((l) => selected.has(l.programId) || l.stepId === activeProgramStepId),
          traced,
          roundTrip: edge.links.some((l) => roundTripKeys.has(`${l.programId}|${l.tableId}`)),
        },
      };
    });
  }, [content, linkVis, contentTables, contentCode, shownColumns, selection.programIds, activeProgramStepId, tracing, traceLinkIds, simulating, lensing, focusSet]);
  const programEdges = useStableList(derivedProgramEdges);

  /** The arrows between code nodes, gathered the same way once a container is folded. */
  const derivedCodeEdges = useMemo<CodeEdgeType[]>(() => {
    if (!content.programs.length) return [];
    const selected = new Set(selection.programIds);
    return drawnCodeEdges(content, linkVis).map((edge) => {
      const first = edge.links[0];
      const stepIndex = edge.direct ? (contentCode.get(edge.fromId)?.steps ?? []).findIndex((s) => s.id === first.stepId) : -1;
      const inFocus = focusSet === null || edge.links.some((l) => focusSet.has(l.fromId) && focusSet.has(l.toId));
      const traced = edge.links.some((l) => traceLinkIds.has(l.id));
      return {
        id: edge.id,
        type: 'codelink' as const,
        source: edge.fromId,
        target: edge.toId,
        selectable: false,
        deletable: false,
        data: {
          op: edge.op,
          step: edge.direct ? first.step : null,
          count: edge.links.length,
          stepId: edge.direct ? first.stepId : null,
          stepIndex,
          summary: edge.links.map((l) => `${contentCode.get(l.fromId)?.name ?? '?'} ${l.op}s ${contentCode.get(l.toId)?.name ?? '?'} (step ${l.step})`),
          dimmed: (tracing && !traced) || simulating || lensing || !inFocus,
          highlighted: selected.has(edge.fromId) || selected.has(edge.toId) || edge.links.some((l) => selected.has(l.fromId) || l.stepId === activeProgramStepId),
          traced,
        },
      };
    });
  }, [content, linkVis, contentCode, selection.programIds, activeProgramStepId, tracing, traceLinkIds, simulating, lensing, focusSet]);
  const codeEdges = useStableList(derivedCodeEdges);

  const derivedRelationEdges = useMemo<RelationEdgeType[]>(() => {
    const prepared = content.relationships.map((r) => {
      const src = contentTables.get(r.sourceTableId);
      const tgt = contentTables.get(r.targetTableId);
      if (!src || !tgt) return null;
      // Rows are indexes into the columns actually drawn; a hidden column anchors the edge at the header.
      const srcShown = shownColumns.get(src.id) ?? src.columns;
      const tgtShown = shownColumns.get(tgt.id) ?? tgt.columns;
      const sourceRow = r.sourceColumnIds.length ? srcShown.findIndex((c) => c.id === r.sourceColumnIds[0]) : -1;
      const targetRow = r.targetColumnIds.length ? tgtShown.findIndex((c) => c.id === r.targetColumnIds[0]) : -1;
      const srcCol = src.columns.find((c) => c.id === r.sourceColumnIds[0]);
      // Relationships sharing identical anchor points would otherwise render as fully overlapping
      // curves — including a reverse pair (A->B and B->A over the same two columns), so the key
      // is direction-independent.
      const a = `${r.sourceTableId}#${sourceRow}`;
      const b = `${r.targetTableId}#${targetRow}`;
      const anchorKey = a < b ? `${a}->${b}` : `${b}->${a}`;
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
      const card = showCardinality && r.kind === 'fk' ? relationshipCardinality(content, r) : null;
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
      // The lens is about how data is computed, so a foreign key is context and a
      // flow off the chain in view is noise.
      const lensDim = lensing && (r.kind !== 'flow' || (lensReach !== null && !lensReach.relationshipIds.has(r.id)));
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
          dimmed: (tracing && !traceRels.has(r.id)) || !inFocus || simDim || lensDim,
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
    // React Flow paints edges in array order, so raising a selected connection above the
    // siblings it overlaps (same table+column anchor on both ends) means moving it to the end.
    const activeId = selection.relationshipId;
    if (activeId) {
      const activeIndex = out.findIndex((e) => e.id === activeId);
      if (activeIndex !== -1 && activeIndex !== out.length - 1) {
        const [active] = out.splice(activeIndex, 1);
        out.push(active);
      }
    }
    return out;
  }, [content, contentTables, selection.relationshipId, tracing, traceRels, selectedTableId, shownColumns, showCardinality, focusSet, simResult, simFlowIndex, simStage, simNonce, simPlaying, simLookupRels, simulating, lensing, lensReach]);
  const relationEdges = useStableList(derivedRelationEdges);

  const edges = useMemo<CanvasEdge[]>(() => [...codeEdges, ...programEdges, ...relationEdges], [codeEdges, programEdges, relationEdges]);

  /* ---------- change handlers ---------- */

  const noteIds = useMemo(() => new Set(diagram.notes.map((n) => n.id)), [diagram.notes]);
  const programIds = useMemo(() => new Set(diagram.programs.map((p) => p.id)), [diagram.programs]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moves: { id: string; position: { x: number; y: number } }[] = [];
      const selects: SelectionChange[] = [];
      for (const ch of changes) {
        // A region's rectangle is derived from its members, so React Flow's own
        // position and size changes for it are noise; onNodeDrag moves the
        // members instead.
        if ('id' in ch && (groupIds.has(ch.id) || expandedCodeIds.has(ch.id))) continue;
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
      if (selects.length) applyNodeSelection(selects, (id) => noteIds.has(id), (id) => programIds.has(id));
    },
    [noteIds, programIds, groupIds, expandedCodeIds, moveItems, mutate, setNodeSize, applyNodeSelection],
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
        programIds: goneNodes.filter((n) => n.type === 'program' || n.type === 'codegroup').map((n) => n.id),
        // A program's arrows belong to its steps, so they are never deleted from
        // the canvas; only real relationships are.
        relationshipIds: goneEdges.filter((e) => e.type === 'relation').map((e) => e.id),
      });
    },
    [removeElements],
  );

  const isValidConnection = useCallback<IsValidConnection<Edge>>(
    (c) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      const sourceCode = codeMap.has(c.source);
      const targetCode = codeMap.has(c.target);
      // Code to code, code to table, table to code: every pairing is a step
      // waiting to be written. Only two tables need their handles read.
      if (sourceCode || targetCode) return (sourceCode || tableMap.has(c.source)) && (targetCode || tableMap.has(c.target));
      if (!tableMap.has(c.source) || !tableMap.has(c.target)) return false;
      const a = parseHandle(c.sourceHandle);
      const b = parseHandle(c.targetHandle);
      if (!a || !b) return false;
      if (a.kind === 'column' && b.kind === 'column' && a.columnId === b.columnId) return false;
      return true;
    },
    [tableMap, codeMap],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      const sourceCode = codeMap.get(c.source);
      const targetCode = codeMap.get(c.target);
      // A drag between two code nodes is a step on the one it left; a drag
      // between code and a table is a read (rows arrive in the code) or a write
      // (rows leave it), whichever way the rows travel.
      if (sourceCode && targetCode) {
        const id = connectCode(c.source, c.target);
        if (!id) {
          toast('info', `${sourceCode.name} already names ${targetCode.name} that way.`);
          return;
        }
        setSelection({ programIds: [c.source], tableIds: [], noteIds: [], relationshipId: null });
        useUi.getState().setActiveProgramStepId(id);
        return;
      }
      if (sourceCode || targetCode) {
        const code = sourceCode ? c.source : c.target;
        const tableId = sourceCode ? c.target : c.source;
        const handle = parseHandle(sourceCode ? c.targetHandle : c.sourceHandle);
        const columnIds = handle?.kind === 'column' ? [handle.columnId] : [];
        const op = sourceCode ? 'write' : 'read';
        const id = connectCodeToTable(code, tableId, op, columnIds);
        if (!id) {
          toast('info', `${codeMap.get(code)?.name ?? 'It'} already ${op}s ${tableMap.get(tableId)?.name ?? 'that table'}.`);
          return;
        }
        setSelection({ programIds: [code], tableIds: [], noteIds: [], relationshipId: null });
        useUi.getState().setActiveProgramStepId(id);
        return;
      }
      const a = parseHandle(c.sourceHandle);
      const b = parseHandle(c.targetHandle);
      if (!a || !b) return;
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
    [diagram.relationships, addRelationship, toast, setSelection, tableMap, codeMap, connectCode, connectCodeToTable],
  );

  /* ---------- dragging tables, code nodes and regions ---------- */

  /** Start of a node drag, whether by one node or by the marquee rectangle. */
  const startNodeDrag = useCallback(
    (dragged: Node[]) => {
      const d = useStore.getState().diagram;
      const tables = dragged.filter((n) => n.type === 'table');
      const code = dragged.filter((n) => n.type === 'program');
      const state: DragState = {
        kind: 'nodes',
        ids: tables.map((n) => n.id),
        codeIds: code.map((n) => n.id),
        startPositions: Object.fromEntries([...tables, ...code].map((n) => [n.id, { ...n.position }])),
        boundsAtStart: groupBounds(d, { sizes: nodeSizes }),
        codeBoundsAtStart: codeBounds(d, { sizes: nodeSizes }),
      };
      dragRef.current = state;
      setDrag(state);
    },
    [nodeSizes],
  );

  /** Highlights the region a dragged table, or the container a dragged code node, would land in. */
  const updateDropTarget = useCallback(
    (node: Node) => {
      if (node.type === 'table') {
        if (diagram.groups.length === 0) return;
        const t = tableMap.get(node.id);
        if (!t) return;
        const size = tableRect(t, nodeSizes);
        const center = rectCenter({ x: node.position.x, y: node.position.y, width: size.width, height: size.height });
        setDropTargetId(resolveGroup(bounds, center, t.groupId));
        return;
      }
      if (node.type !== 'program') return;
      const p = codeMap.get(node.id);
      if (!p) return;
      const size = nodeSizes[p.id] ?? estimateProgramSize(p, { hiddenMembers: codeVis.hidden.get(p.id) ?? 0 });
      const center = { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
      setDropTargetId(resolveCodeParent(diagram, codeRegions, p, center, new Set(codeSubtreeIds(diagram, [p.id]))));
    },
    [diagram, tableMap, codeMap, nodeSizes, bounds, codeRegions, codeVis],
  );

  const onNodeDragStart = useCallback(
    (_e: MouseEvent | TouchEvent, node: Node, dragged: Node[]) => {
      beginDrag();
      if (node.type !== 'tablegroup' && node.type !== 'codegroup') {
        startNodeDrag(dragged.length ? dragged : [node]);
        return;
      }
      const d = useStore.getState().diagram;
      const boundsAtStart = groupBounds(d, { sizes: nodeSizes });
      const codeBoundsAtStart = codeBounds(d, { sizes: nodeSizes });
      if (node.type === 'tablegroup') {
        const members = d.tables.filter((t) => t.groupId === node.id);
        const state: DragState = {
          kind: 'group',
          ids: members.map((t) => t.id),
          codeIds: [],
          startPositions: Object.fromEntries(members.map((t) => [t.id, { ...t.position }])),
          groupId: node.id,
          groupStart: { ...node.position },
          boundsAtStart,
          codeBoundsAtStart,
        };
        dragRef.current = state;
        setDrag(state);
        selectGroup(node.id);
        return;
      }
      // A container's region carries everything inside it, at any depth,
      // including whatever is folded away inside a folded member.
      const members = codeDescendantIds(d, node.id).flatMap((id) => d.programs.filter((p) => p.id === id));
      const state: DragState = {
        kind: 'codegroup',
        ids: [],
        codeIds: members.map((p) => p.id),
        startPositions: Object.fromEntries(members.map((p) => [p.id, { ...p.position }])),
        groupId: node.id,
        groupStart: { ...node.position },
        boundsAtStart,
        codeBoundsAtStart,
      };
      dragRef.current = state;
      setDrag(state);
      setSelection({ programIds: [node.id], tableIds: [], noteIds: [], relationshipId: null, groupId: null });
    },
    [beginDrag, nodeSizes, selectGroup, startNodeDrag, setSelection],
  );

  const onNodeDrag = useCallback(
    (_e: MouseEvent | TouchEvent, node: Node) => {
      const state = dragRef.current;
      if (!state) return;
      if (state.kind === 'group' || state.kind === 'codegroup') {
        if (node.id !== state.groupId || !state.groupStart) return;
        // Absolute, not incremental: a dropped frame can never accumulate drift.
        const dx = node.position.x - state.groupStart.x;
        const dy = node.position.y - state.groupStart.y;
        const ids = state.kind === 'group' ? state.ids : state.codeIds;
        moveItems(ids.map((id) => ({ id, position: { x: state.startPositions[id].x + dx, y: state.startPositions[id].y + dy } })));
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

    if (state) {
      const d = useStore.getState().diagram;
      if (state.kind === 'group' && state.groupId) {
        // Keep the fallback anchor under the region, so emptying it later does
        // not teleport the box back to where it was first created.
        const box = groupBounds(d, { sizes: nodeSizes })[state.groupId];
        if (box) moveGroup(state.groupId, [], { x: Math.round(box.x), y: Math.round(box.y) });
      } else if (state.kind === 'codegroup' && state.groupId) {
        const box = codeBounds(d, { sizes: nodeSizes })[state.groupId];
        if (box) moveCodeContainer(state.groupId, [], { x: Math.round(box.x), y: Math.round(box.y) });
      } else if (state.kind === 'nodes') {
        if (state.ids.length && d.groups.length) {
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
        if (state.codeIds.length) {
          // Dropping into a container: the dragged nodes and everything inside
          // them are left out of the regions, so a container never swallows a
          // node because the node's own region grew to meet it.
          const vis = codeVisibility(d);
          const skip = new Set(codeSubtreeIds(d, state.codeIds));
          const dropped = codeBounds(d, { sizes: nodeSizes, exclude: skip, fallback: state.codeBoundsAtStart }, vis);
          for (const id of state.codeIds) {
            const p = d.programs.find((x) => x.id === id);
            if (!p) continue;
            const size = nodeSizes[p.id] ?? estimateProgramSize(p, { hiddenMembers: vis.hidden.get(p.id) ?? 0 });
            const center = { x: p.position.x + size.width / 2, y: p.position.y + size.height / 2 };
            const target = resolveCodeParent(d, dropped, p, center, skip);
            if ((p.parentId ?? null) !== target) setCodeParent([id], target);
          }
        }
      }
    }
    endDrag();
  }, [nodeSizes, moveGroup, moveCodeContainer, setCodeParent, mutate, endDrag]);

  /**
   * Dragging the marquee rectangle reports through the selection callbacks
   * instead of the node ones, so it has to run the same membership pass or a
   * boxed group of tables would move without ever joining or leaving a region.
   */
  const onSelectionDragStart = useCallback(
    (_e: React.MouseEvent, dragged: Node[]) => {
      beginDrag();
      startNodeDrag(dragged);
    },
    [beginDrag, startNodeDrag],
  );

  const onSelectionDrag = useCallback(
    (_e: React.MouseEvent, dragged: Node[]) => {
      const first = dragged.find((n) => n.type === 'table' || n.type === 'program');
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
      if (node.type === 'codegroup') {
        setSelection({ programIds: [node.id], tableIds: [], noteIds: [], relationshipId: null, groupId: null });
        setInspectorOpen(true);
        return;
      }
      // A trace can start or end at code as well as at a table.
      if (!trace.picking || (node.type !== 'table' && node.type !== 'program')) return;
      if (!trace.fromId) {
        setTraceEndpoints(node.id, null);
      } else if (node.id !== trace.fromId) {
        setTraceEndpoints(trace.fromId, node.id);
        // runTrace reads the store synchronously after the update above
        setTimeout(() => runTrace(), 0);
      }
    },
    [trace.picking, trace.fromId, setTraceEndpoints, runTrace, selectGroup, setSelection, setInspectorOpen],
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
      const isNote = node.type === 'note';
      const isCode = node.type === 'program' || node.type === 'codegroup';
      // Right-clicking inside a group selection keeps it and acts on the group.
      const groupSize = selection.tableIds.length + selection.noteIds.length + selection.programIds.length;
      const inSelection = isNote ? selection.noteIds : isCode ? selection.programIds : selection.tableIds;
      if (groupSize > 1 && inSelection.includes(node.id)) {
        openContextMenu(e, { type: 'selection' });
        return;
      }
      if (isNote) {
        setSelection({ tableIds: [], relationshipId: null, noteIds: [node.id] });
        openContextMenu(e, { type: 'note', noteId: node.id });
        return;
      }
      if (isCode) {
        setSelection({ tableIds: [], relationshipId: null, noteIds: [], programIds: [node.id] });
        openContextMenu(e, { type: 'program', programId: node.id });
        return;
      }
      setSelection({ tableIds: [node.id], relationshipId: null, noteIds: [] });
      const columnId = (e.target as Element | null)?.closest?.('[data-column-id]')?.getAttribute('data-column-id') ?? undefined;
      openContextMenu(e, { type: 'table', tableId: node.id, columnId });
    },
    [selection.tableIds, selection.noteIds, selection.programIds, setSelection, selectGroup],
  );

  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      // A derived arrow belongs to its step: the menu it gets is the node's.
      if (edge.type !== 'relation') {
        const owner = edge.source;
        if (codeMap.has(owner)) {
          setSelection({ tableIds: [], relationshipId: null, noteIds: [], programIds: [owner] });
          openContextMenu(e, { type: 'program', programId: owner });
        }
        return;
      }
      setSelection({ relationshipId: edge.id, tableIds: [], noteIds: [] });
      openContextMenu(e, { type: 'relationship', relationshipId: edge.id });
    },
    [setSelection, codeMap],
  );

  const onSelectionContextMenu = useCallback(
    (e: React.MouseEvent, picked: Node[]) => {
      const tableIds = picked.filter((n) => n.type === 'table').map((n) => n.id);
      const noteIds = picked.filter((n) => n.type === 'note').map((n) => n.id);
      const programIds = picked.filter((n) => n.type === 'program').map((n) => n.id);
      if (tableIds.length || noteIds.length || programIds.length) setSelection({ tableIds, noteIds, programIds, relationshipId: null });
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
    const ids = [...new Set(trace.result.nodeIds.map((id) => codeVis.standIn.get(id) ?? id))].map((id) => ({ id }));
    const t = setTimeout(() => fitView({ nodes: ids, duration: 500, padding: 0.25, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
    // The stand-in map only changes with the diagram, and a trace is cleared on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace.result, fitView]);

  useEffect(() => {
    if (!focusTableId) return;
    // fitView's zoom is set by how much space the node set needs, so with a
    // few neighbors in the mix it usually lands well under maxZoom and the
    // cap never kicks in — raising it did nothing. Force the zoom instead of
    // fitting to a bounding box, so a click always lands at the same close level.
    const t = tableMap.get(focusTableId);
    const p = codeMap.get(focusTableId);
    if (t) {
      const center = rectCenter(tableRect(t, nodeSizes));
      void setCenter(center.x, center.y, { zoom: 1.75, duration: 500 });
    } else if (p) {
      // A node folded away inside a container is found where the container is.
      const stand = codeMap.get(codeVis.standIn.get(p.id) ?? p.id) ?? p;
      const region = codeRegions[stand.id];
      const size = region ? { width: region.width, height: region.height } : (nodeSizes[stand.id] ?? estimateProgramSize(stand));
      const at = region ? { x: region.x, y: region.y } : stand.position;
      void setCenter(at.x + size.width / 2, at.y + size.height / 2, { zoom: region ? 1 : 1.75, duration: 500 });
    }
    focusTable(null);
  }, [focusTableId, tableMap, codeMap, codeVis, codeRegions, nodeSizes, setCenter, focusTable]);

  useEffect(() => {
    if (!focusRelationshipId) return;
    const r = diagram.relationships.find((rel) => rel.id === focusRelationshipId);
    const src = r && tableMap.get(r.sourceTableId);
    const tgt = r && tableMap.get(r.targetTableId);
    if (src && tgt) {
      // Same fixed zoom as focusTable, centered between the two ends so a click always lands close in.
      const a = rectCenter(tableRect(src, nodeSizes));
      const b = rectCenter(tableRect(tgt, nodeSizes));
      void setCenter((a.x + b.x) / 2, (a.y + b.y) / 2, { zoom: 1.75, duration: 500 });
    }
    focusRelationship(null);
  }, [focusRelationshipId, diagram.relationships, tableMap, nodeSizes, setCenter, focusRelationship]);

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
  const focusKey = focus ? `${focus.nodeId}:${focus.hops}` : '';
  useEffect(() => {
    if (!focusVisible || !focusKey) return;
    const t = setTimeout(() => fitView({ nodes: [...focusVisible].map((id) => ({ id })), duration: 400, padding: 0.3, maxZoom: 1.1 }), 40);
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
        if (!s.selection.tableIds.length && !s.selection.noteIds.length && !s.selection.programIds.length) return;
        const step = e.shiftKey ? 50 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        e.preventDefault();
        nudgeSelection(dx, dy);
        return;
      }
      // One selected table or code node: focus on its neighbourhood, or rename it.
      const only =
        s.selection.tableIds.length === 1 && !s.selection.programIds.length
          ? s.selection.tableIds[0]
          : s.selection.programIds.length === 1 && !s.selection.tableIds.length
            ? s.selection.programIds[0]
            : null;
      if (e.key === '.' && only) {
        e.preventDefault();
        ui.setFocus(ui.focus?.nodeId === only ? null : { nodeId: only, hops: 1 });
        return;
      }
      if ((e.key === '[' || e.key === ']') && ui.focus) {
        e.preventDefault();
        const hops = Math.max(1, Math.min(MAX_FOCUS_HOPS, ui.focus.hops + (e.key === ']' ? 1 : -1)));
        ui.setFocus({ nodeId: ui.focus.nodeId, hops });
        return;
      }
      if (e.key === 'F2' && only) {
        e.preventDefault();
        ui.setRenamingNodeId(only);
        return;
      }
      if (e.key === 'Escape' && !s.trace.picking && !s.trace.result && !useSimulation.getState().targetId) {
        // One Esc widens a lineage back to the whole diagram; the next puts the lens away.
        if (ui.derived?.columnId) ui.showLineage(null);
        else if (ui.derived) ui.setDerived(null);
        else if (ui.focus) ui.setFocus(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudgeSelection]);

  /* ---------- copy / cut / paste ---------- */

  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const sel = useStore.getState().selection;
      if (isEditable(e.target) || (!sel.tableIds.length && !sel.programIds.length)) return;
      e.preventDefault();
      const n = writeSelectionToEvent(e);
      if (n) useStore.getState().toast('success', copiedMessage(n));
    };
    const onCut = (e: ClipboardEvent) => {
      const sel = useStore.getState().selection;
      if (isEditable(e.target) || (!sel.tableIds.length && !sel.programIds.length)) return;
      e.preventDefault();
      // Nothing reached the clipboard (a stale selection, say) — deleting now
      // would destroy the tables with no copy of them anywhere.
      if (!writeSelectionToEvent(e)) return;
      cutSelection({ alreadyOnClipboard: true });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target)) return;
      if (pasteFromEvent(e)) e.preventDefault();
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

  const nameOf = (id: string) => tableMap.get(id)?.name ?? codeMap.get(id)?.name ?? '?';
  const pickingLabel = trace.picking ? (trace.fromId ? `From ${nameOf(trace.fromId)}: now click the destination table or code node` : 'Click the starting table or code node') : null;
  // Two different emptinesses. A canvas nobody has chosen a direction on gets
  // the opening question; one where the direction is known gets a hint for that
  // direction, and never "add a table" to someone who came here to draw code.
  const blank = isBlankDiagram(diagram);
  const asking = showsStartScreen(diagram);

  return (
    <div ref={wrapperRef} className="app__canvas" data-tour="canvas" onDoubleClick={onPaneDoubleClick} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
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
          if (renamingNodeId) setRenamingNodeId(null);
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
            if (n.type === 'tablegroup' || n.type === 'codegroup') return 'var(--minimap-group)';
            if (n.type === 'program') return 'var(--program)';
            return 'var(--flow)';
          }}
          nodeStrokeWidth={0}
          maskColor="rgba(0,0,0,0.25)"
        />
      </ReactFlow>
      {!pickingLabel && !simulating && !lensing && <FocusBanner />}
      {!pickingLabel && lensing && <DerivedBanner />}
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
      {asking && <StartPanel />}
      {blank && !asking && (
        <div className="canvas__empty">
          <div className="canvas__empty-card">
            <h2>Empty diagram</h2>
            {emphasis === 'code' ? (
              <p>
                Double-click the canvas or press C to add a program, module, class or function. Press T if you also want a table — the database tools come back with it.
              </p>
            ) : emphasis === 'data' ? (
              <p>Double-click the canvas or press T to add a table, paste CREATE TABLE statements, or pull a schema from a running database.</p>
            ) : (
              <p>Double-click the canvas to add a table, press C for a piece of code, or import a schema you already have.</p>
            )}
            <div className="row" style={{ justifyContent: 'center' }}>
              {emphasis !== 'data' && (
                <button className={`btn${emphasis === 'code' ? ' btn--primary' : ''}`} onClick={() => void (addProgram(), setInspectorOpen(true))}>
                  Add code
                </button>
              )}
              {emphasis !== 'code' && (
                <button className={`btn${emphasis === 'data' ? ' btn--primary' : ''}`} onClick={() => addTable()}>
                  Add table
                </button>
              )}
              {emphasis !== 'code' && (
                <button className="btn" onClick={() => openDrawer('import')}>
                  Import SQL
                </button>
              )}
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

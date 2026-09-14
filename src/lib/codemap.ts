/**
 * Code maps: the reasoning about the code side of the diagram once programs
 * can contain modules, modules classes, and classes functions.
 *
 * Three things here are derived and never stored, for the reason the rest of
 * the app already gives: two halves that are computed from one source cannot
 * drift apart.
 *
 *  - Which node stands in for which. A collapsed container hides everything
 *    inside it, so every descendant is represented by its outermost collapsed
 *    ancestor; the canvas, the layout and the exports all ask this module
 *    rather than each working it out.
 *  - The arrows. A call, an import, an extends or a load step names another
 *    code node the way a read names a table, and the edge is derived from the
 *    step — a load being the one that points at a data file rather than at
 *    code, since that is the only arrow a data file may be on the end of. When
 *    the two ends are hidden inside collapsed containers the edge is drawn
 *    between the containers instead, with the hidden steps gathered onto it,
 *    so a folded map still shows what talks to what.
 *  - The regions. An expanded container has no rectangle of its own: it is the
 *    bounding box of its members, exactly as a group is the bounding box of its
 *    tables, and `Program.position` is only where it falls back to while empty.
 *
 * Containment is a pointer on the child (`parentId`) rather than a list on the
 * parent, again mirroring groups, and the alternative was rejected for the
 * same reason: a member list and a member pointer would have to be kept in
 * step by every action that moves a node.
 */
import { canContain, canStepName, codeKindMeta, codeKindOf, isCodeStepOp, type CodeKind, type Diagram, type Program, type ProgramStep } from '@shared/types';
import { estimateProgramSize, PROGRAM_WIDTH, programLinkId, programLinks, type ProgramLink } from './programs';
import type { Rect, SizeMap } from './groups';

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

export function codeById(d: Diagram): Map<string, Program> {
  return new Map(d.programs.map((p) => [p.id, p]));
}

/** Children of every node, in diagram order; the key null holds the roots. */
export function codeChildren(d: Diagram): Map<string | null, Program[]> {
  const out = new Map<string | null, Program[]>();
  const known = new Set(d.programs.map((p) => p.id));
  for (const p of d.programs) {
    const key = p.parentId && known.has(p.parentId) ? p.parentId : null;
    const list = out.get(key);
    if (list) list.push(p);
    else out.set(key, [p]);
  }
  return out;
}

/** The chain of containers above a node, nearest first. Stops at a cycle rather than looping. */
export function codeAncestors(d: Diagram, id: string, byId: Map<string, Program> = codeById(d)): Program[] {
  const out: Program[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    seen.add(parent.id);
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** Every node inside `id`, at any depth, in diagram order. Does not include `id` itself. */
export function codeDescendantIds(d: Diagram, id: string, children: Map<string | null, Program[]> = codeChildren(d)): string[] {
  const out: string[] = [];
  const stack = [...(children.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (stack.length) {
    const p = stack.shift()!;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p.id);
    stack.push(...(children.get(p.id) ?? []));
  }
  return out;
}

/** `ids` plus everything inside them: what moves when they move, and what goes when they go. */
export function codeSubtreeIds(d: Diagram, ids: Iterable<string>): string[] {
  const children = codeChildren(d);
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    for (const x of codeDescendantIds(d, id, children)) out.add(x);
  }
  return [...out];
}

/** How many containers sit above a node. Roots are at depth 0. */
export function codeDepth(d: Diagram, id: string, byId?: Map<string, Program>): number {
  return codeAncestors(d, id, byId).length;
}

/** True when making `parentId` the parent of `id` would put a node inside itself. */
export function wouldNestInItself(d: Diagram, id: string, parentId: string): boolean {
  if (id === parentId) return true;
  return codeAncestors(d, parentId).some((a) => a.id === id);
}

/** Whether `child` may be dropped into `parent`: the kinds allow it and no cycle results. */
export function canBeParentOf(d: Diagram, parent: Program, child: Program): boolean {
  return canContain(codeKindOf(parent), codeKindOf(child)) && !wouldNestInItself(d, child.id, parent.id);
}

/**
 * "api/orders.py/place_order": the node's name under its containers'. This is
 * how the SQL annotation block and the walkthrough goals name a node, because
 * two classes may each have a `save` and an id means nothing outside its file.
 */
export function codePath(d: Diagram, p: Program, byId?: Map<string, Program>): string {
  return [...codeAncestors(d, p.id, byId).reverse().map((a) => a.name), p.name].join('/');
}

/**
 * The node a path names. An exact path wins; failing that, a bare name that
 * only one node in the whole map carries is accepted, so a hand-written
 * `calls | place_order -> save_order` need not spell out containers nobody
 * would confuse.
 */
export function findCodeByPath(d: Diagram, path: string): Program | undefined {
  const want = path.trim().toLowerCase();
  if (!want) return undefined;
  const byId = codeById(d);
  const exact = d.programs.find((p) => codePath(d, p, byId).toLowerCase() === want);
  if (exact) return exact;
  const tail = want.slice(want.lastIndexOf('/') + 1);
  const byName = d.programs.filter((p) => p.name.trim().toLowerCase() === tail);
  return byName.length === 1 ? byName[0] : undefined;
}

/* ------------------------------------------------------------------ */
/* Collapse: who stands in for whom                                    */
/* ------------------------------------------------------------------ */

export interface CodeVisibility {
  /** For every node, the node drawn in its place: itself, or the outermost collapsed container above it. */
  standIn: Map<string, string>;
  /** Nodes actually drawn, in diagram order. */
  drawn: Program[];
  /** Drawn containers whose members are laid out inside a region. */
  expanded: Program[];
  /** Drawn containers folded to one node. */
  collapsed: Program[];
  /** How many nodes each collapsed container hides. */
  hidden: Map<string, number>;
}

export function codeVisibility(d: Diagram): CodeVisibility {
  const byId = codeById(d);
  const children = codeChildren(d);
  const standIn = new Map<string, string>();
  const hidden = new Map<string, number>();
  for (const p of d.programs) {
    // Outermost wins: a class folded inside a folded module is not drawn at
    // all, so it is the module that answers for the class's functions.
    let stand = p.id;
    for (const a of codeAncestors(d, p.id, byId)) if (a.collapsed) stand = a.id;
    standIn.set(p.id, stand);
    if (stand !== p.id) hidden.set(stand, (hidden.get(stand) ?? 0) + 1);
  }
  const drawn = d.programs.filter((p) => standIn.get(p.id) === p.id);
  const expanded = drawn.filter((p) => codeKindMeta(codeKindOf(p)).container && !p.collapsed && (children.get(p.id)?.length ?? 0) > 0);
  const collapsed = drawn.filter((p) => p.collapsed && (children.get(p.id)?.length ?? 0) > 0);
  return { standIn, drawn, expanded, collapsed, hidden };
}

/* ------------------------------------------------------------------ */
/* The arrows between code nodes                                       */
/* ------------------------------------------------------------------ */

export type CodeLinkOp = 'call' | 'import' | 'extends' | 'load';

/** One arrow from a code node to another, derived from one step of the first. */
export interface CodeLink {
  /** Stable and unique per step, so React Flow can key on it. */
  id: string;
  fromId: string;
  toId: string;
  stepId: string;
  op: CodeLinkOp;
  /** 1-based position of the step within its node. */
  step: number;
}

/** Every arrow the code steps imply. A step naming a node that is gone draws nothing; the linter reports it. */
export function codeLinks(d: Diagram, known: ReadonlySet<string> = new Set(d.programs.map((p) => p.id))): CodeLink[] {
  const out: CodeLink[] = [];
  for (const p of d.programs) {
    p.steps.forEach((s, i) => {
      if (!isCodeStepOp(s.op) || !s.codeId || !known.has(s.codeId)) return;
      out.push({ id: programLinkId(p.id, s.id), fromId: p.id, toId: s.codeId, stepId: s.id, op: s.op, step: i + 1 });
    });
  }
  return out;
}

/**
 * An arrow as the canvas draws it once collapsed containers are taken into
 * account: from the node standing in for the caller to the node standing in
 * for the callee, carrying every step it gathered. `direct` is true when the
 * from end is the very node whose step it is, which is when the arrow can be
 * anchored on the step row and numbered.
 */
export interface DrawnCodeEdge {
  id: string;
  fromId: string;
  toId: string;
  op: CodeLinkOp;
  links: CodeLink[];
  direct: boolean;
}

export function drawnCodeEdges(d: Diagram, vis: CodeVisibility = codeVisibility(d)): DrawnCodeEdge[] {
  const out = new Map<string, DrawnCodeEdge>();
  for (const link of codeLinks(d)) {
    const fromId = vis.standIn.get(link.fromId) ?? link.fromId;
    const toId = vis.standIn.get(link.toId) ?? link.toId;
    // A call between two functions of the same folded module is inside the
    // node now, and an arrow from a node to itself says nothing.
    if (fromId === toId) continue;
    const direct = fromId === link.fromId;
    // Direct arrows keep one edge per step, numbered; gathered ones merge per
    // op, because "three calls into this module" is the readable fact.
    const key = direct ? link.id : `${fromId}|${toId}|${link.op}`;
    const edge = out.get(key);
    if (edge) edge.links.push(link);
    else out.set(key, { id: key, fromId, toId, op: link.op, links: [link], direct });
  }
  return [...out.values()];
}

/** The same gathering for the arrows between code and tables. */
export interface DrawnTableLink {
  id: string;
  nodeId: string;
  tableId: string;
  op: 'read' | 'write';
  links: ProgramLink[];
  direct: boolean;
}

export function drawnTableLinks(d: Diagram, vis: CodeVisibility = codeVisibility(d), tableIds?: ReadonlySet<string>): DrawnTableLink[] {
  const out = new Map<string, DrawnTableLink>();
  for (const link of programLinks(d, tableIds)) {
    const nodeId = vis.standIn.get(link.programId) ?? link.programId;
    const direct = nodeId === link.programId;
    const key = direct ? link.id : `${nodeId}|${link.tableId}|${link.op}`;
    const edge = out.get(key);
    if (edge) edge.links.push(link);
    else out.set(key, { id: key, nodeId, tableId: link.tableId, op: link.op, links: [link], direct });
  }
  return [...out.values()];
}

/** Code nodes that name `id` in a call, import or extends step, in diagram order. */
export function callersOf(d: Diagram, id: string): Program[] {
  return d.programs.filter((p) => p.steps.some((s) => isCodeStepOp(s.op) && s.codeId === id));
}

/** The code nodes a node's steps name, in the order its steps first reach them. */
export function codeTargetIds(p: Program): string[] {
  const out: string[] = [];
  for (const s of p.steps) {
    if (!isCodeStepOp(s.op) || !s.codeId) continue;
    if (!out.includes(s.codeId)) out.push(s.codeId);
  }
  return out;
}

/**
 * Cycles among import steps, each reported once as the nodes on it in order.
 * A module that imports a module that imports it back is the classic
 * circular-import trap, and it hides well in a big map, which is why the
 * linter asks here rather than leaving it to the eye.
 */
export function importCycles(d: Diagram): string[][] {
  const adj = new Map<string, string[]>();
  const known = new Set(d.programs.map((p) => p.id));
  for (const p of d.programs) {
    adj.set(
      p.id,
      p.steps.filter((s) => s.op === 'import' && s.codeId && known.has(s.codeId)).map((s) => s.codeId!),
    );
  }
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 'open');
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next);
      if (s === 'done') continue;
      if (s === 'open') {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort().join(',');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
        continue;
      }
      visit(next);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const p of d.programs) if (!state.has(p.id)) visit(p.id);
  return cycles;
}

/* ------------------------------------------------------------------ */
/* Geometry: regions for expanded containers                           */
/* ------------------------------------------------------------------ */

/** Space between a container's members and its border. */
export const CODE_PADDING = 22;
/** Extra room above the members for the container's title strip. */
export const CODE_HEADER = 30;
/** Box drawn for an expanded container that has nothing in it yet. */
export const EMPTY_CODE_WIDTH = PROGRAM_WIDTH + CODE_PADDING * 2;
export const EMPTY_CODE_HEIGHT = 150;

export interface CodeBoundsOptions {
  sizes?: SizeMap;
  /** Nodes to leave out, used while they are dragged so the region holds still. */
  exclude?: ReadonlySet<string>;
  /** Boxes to fall back to for a region left with nothing in it. */
  fallback?: Record<string, Rect>;
}

/** The rectangle of a drawn node: its measured size, or the estimate for what it shows. */
export function codeNodeRect(p: Program, vis: CodeVisibility, sizes?: SizeMap): Rect {
  const size = sizes?.[p.id] ?? estimateProgramSize(p, { hiddenMembers: vis.hidden.get(p.id) ?? 0 });
  return { x: p.position.x, y: p.position.y, width: size.width, height: size.height };
}

/**
 * The region of every expanded container, keyed by id. Computed deepest first,
 * so a module's box is the bounding box of its classes' boxes, which are the
 * bounding boxes of their functions. Deliberately not rounded, for the reason
 * groups give: while a member is dragged its region follows sub-pixel
 * positions, and rounding would fight React Flow.
 */
export function codeBounds(d: Diagram, opts: CodeBoundsOptions = {}, vis: CodeVisibility = codeVisibility(d)): Record<string, Rect> {
  const byId = codeById(d);
  const children = codeChildren(d);
  const out: Record<string, Rect> = {};
  const expanded = new Set(vis.expanded.map((p) => p.id));
  const order = [...vis.expanded].sort((a, b) => codeDepth(d, b.id, byId) - codeDepth(d, a.id, byId));
  for (const container of order) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const child of children.get(container.id) ?? []) {
      if (opts.exclude?.has(child.id)) continue;
      // A hidden child (inside a collapsed sibling container) never happens:
      // it is inside this container's child, which is drawn.
      const r = expanded.has(child.id) ? out[child.id] : codeNodeRect(child, vis, opts.sizes);
      if (!r) continue;
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    }
    if (!Number.isFinite(minX)) {
      out[container.id] = opts.fallback?.[container.id] ?? { x: container.position.x, y: container.position.y, width: EMPTY_CODE_WIDTH, height: EMPTY_CODE_HEIGHT };
      continue;
    }
    out[container.id] = {
      x: minX - CODE_PADDING,
      y: minY - CODE_PADDING - CODE_HEADER,
      width: maxX - minX + CODE_PADDING * 2,
      height: maxY - minY + CODE_PADDING * 2 + CODE_HEADER,
    };
  }
  // Drawn containers with no members yet still get a region, so there is
  // something on the canvas to drop the first member into.
  for (const p of vis.drawn) {
    if (out[p.id] || p.collapsed || !codeKindMeta(codeKindOf(p)).container) continue;
    if ((children.get(p.id)?.length ?? 0) > 0) continue;
    out[p.id] = opts.fallback?.[p.id] ?? { x: p.position.x, y: p.position.y, width: EMPTY_CODE_WIDTH, height: EMPTY_CODE_HEIGHT };
  }
  return out;
}

/** The container whose region a point falls in; the smallest wins, and `skip` is never considered. */
export function codeContainerAtPoint(bounds: Record<string, Rect>, p: { x: number; y: number }, skip: ReadonlySet<string> = new Set()): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const [id, r] of Object.entries(bounds)) {
    if (skip.has(id)) continue;
    if (p.x < r.x || p.x > r.x + r.width || p.y < r.y || p.y > r.y + r.height) continue;
    const area = r.width * r.height;
    if (area < bestArea) {
      best = id;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Where a new member of `parentId` goes: under the parent's last member, or in
 * the empty region's top-left corner. Without a parent, below everything.
 */
export function nextCodePosition(d: Diagram, parentId: string | undefined, fallback: { x: number; y: number }, sizes?: SizeMap): { x: number; y: number } {
  if (!parentId) return fallback;
  const parent = d.programs.find((p) => p.id === parentId);
  if (!parent) return fallback;
  const vis = codeVisibility(d);
  const members = d.programs.filter((p) => p.parentId === parentId);
  if (!members.length) return { x: Math.round(parent.position.x + CODE_PADDING), y: Math.round(parent.position.y + CODE_PADDING + CODE_HEADER) };
  let minX = Infinity;
  let maxY = -Infinity;
  const bounds = codeBounds(d, { sizes }, vis);
  for (const m of members) {
    const r = bounds[m.id] ?? codeNodeRect(m, vis, sizes);
    minX = Math.min(minX, r.x);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: Math.round(minX), y: Math.round(maxY + 30) };
}

/* ------------------------------------------------------------------ */
/* Prose                                                               */
/* ------------------------------------------------------------------ */

/** "module", "class", "function", "program" — the word for a node in a sentence. */
export function codeNoun(p: Pick<Program, 'kind'>): string {
  return codeKindMeta(codeKindOf(p)).label.toLowerCase();
}

/** The op a drag between two code nodes should mean, from what the two are. */
export function defaultCodeOp(from: Pick<Program, 'kind'>, to: Pick<Program, 'kind'>): CodeLinkOp {
  const a = codeKindOf(from);
  const b = codeKindOf(to);
  // Only one thing can be meant by an arrow into a data file, and nothing can
  // be meant by one out of it — `canLinkCode` refuses that before this is asked.
  if (b === 'data') return 'load';
  if (a === 'class' && b === 'class') return 'extends';
  if (a === 'module' || a === 'program') return b === 'function' || b === 'class' ? 'import' : 'import';
  return 'call';
}

/**
 * Whether an arrow may be drawn from one code node to another at all.
 *
 * The data files are the whole of this rule: nothing runs in one, so it has no
 * steps to draw an arrow from, and the only arrow into one is a load. Every
 * other pairing is allowed, because a map of real code holds stranger shapes
 * than a rule here would let through.
 */
export function canLinkCode(from: Pick<Program, 'kind'>, to: Pick<Program, 'kind'>, op?: CodeLinkOp): boolean {
  if (codeKindOf(from) === 'data') return false;
  return canStepName(op ?? defaultCodeOp(from, to), codeKindOf(to));
}

/** The kinds a node of `kind` may be dropped into, for pickers. */
export function parentKindsOf(kind: CodeKind): CodeKind[] {
  return codeKindMeta(kind).parents;
}

/** Steps of a node that name code, with their targets resolved. */
export function codeStepsOf(d: Diagram, p: Program): { step: ProgramStep; target: Program | undefined }[] {
  const byId = codeById(d);
  return p.steps.filter((s) => isCodeStepOp(s.op)).map((step) => ({ step, target: step.codeId ? byId.get(step.codeId) : undefined }));
}

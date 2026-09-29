import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore, type ReactFlowState } from '@xyflow/react';

/**
 * React Flow's own EdgeLabelRenderer, minus its cost.
 *
 * The stock component finds the label layer with a store selector that runs
 * `domNode.querySelector` — and a selector runs on every store update, for
 * every label. A procedure with a hundred steps draws a hundred labels, and
 * dragging anything updates the store several times a frame, so the canvas
 * spent more time searching its own DOM for one div than drawing the arrows.
 * The layer never moves once the canvas is mounted, so it is looked up once
 * per canvas and remembered.
 */
const LAYER = '.react-flow__edgelabel-renderer';
const layers = new WeakMap<HTMLElement, HTMLElement>();
const domNodeOf = (s: ReactFlowState) => s.domNode;

function labelLayer(domNode: HTMLElement | null): HTMLElement | null {
  if (!domNode) return null;
  const cached = layers.get(domNode);
  if (cached?.isConnected) return cached;
  const found = domNode.querySelector<HTMLElement>(LAYER);
  if (found) layers.set(domNode, found);
  return found;
}

export function EdgeLabelPortal({ children }: { children: ReactNode }) {
  const domNode = useStore(domNodeOf);
  const layer = labelLayer(domNode);
  // An edge rendered in the same commit as the layer can look before the
  // layer is in the document. Ask once more after the commit; the stock
  // component gets this for free by re-querying on every update.
  const [, setRetry] = useState(0);
  const retried = useRef(false);
  useLayoutEffect(() => {
    if (domNode && !layer && !retried.current) {
      retried.current = true;
      setRetry((n) => n + 1);
    }
  }, [domNode, layer]);
  return layer ? createPortal(children, layer) : null;
}

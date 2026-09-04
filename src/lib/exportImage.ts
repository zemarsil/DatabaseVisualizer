import { toPng, toSvg } from 'html-to-image';
import { getViewportForBounds, type Rect } from '@xyflow/react';

export type ImageFormat = 'png' | 'svg';

/**
 * Render the current canvas (nodes + edges, no controls) to a data URL.
 * The viewport is re-positioned so that every node is inside the image.
 */
export async function exportDiagramImage(bounds: Rect, format: ImageFormat, opts: { background: string; scale?: number; padding?: number }): Promise<string> {
  const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null;
  const flow = document.querySelector('.react-flow') as HTMLElement | null;
  if (!viewport || !flow) throw new Error('The canvas is not mounted.');
  if (bounds.width === 0 && bounds.height === 0) throw new Error('There is nothing to export yet.');

  const pad = opts.padding ?? 64;
  const width = Math.max(200, Math.ceil(bounds.width + pad * 2));
  const height = Math.max(120, Math.ceil(bounds.height + pad * 2));
  const vp = getViewportForBounds(bounds, width, height, 1, 1, 0);

  flow.classList.add('exporting');
  try {
    const common = {
      backgroundColor: opts.background,
      width,
      height,
      skipFonts: true,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
      },
    };
    if (format === 'png') return await toPng(viewport, { ...common, pixelRatio: opts.scale ?? 2 });
    return await toSvg(viewport, common);
  } finally {
    flow.classList.remove('exporting');
  }
}

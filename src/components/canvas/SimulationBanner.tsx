import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useSimulation } from '@/store/useSimulation';

/** Shown while a data-flow simulation is on: what is being fed, which stage is in play, and the transport controls. */
export function SimulationBanner() {
  const targetId = useSimulation((s) => s.targetId);
  const result = useSimulation((s) => s.result);
  const stage = useSimulation((s) => s.stage);
  const playing = useSimulation((s) => s.playing);
  const play = useSimulation((s) => s.play);
  const pause = useSimulation((s) => s.pause);
  const step = useSimulation((s) => s.step);
  const stop = useSimulation((s) => s.stop);
  const openDrawer = useStore((s) => s.openDrawer);
  const name = useStore((s) => (targetId ? s.diagram.tables.find((t) => t.id === targetId)?.name : undefined));
  if (!targetId || !result) return null;
  const current = stage >= 0 ? result.stages[stage] : null;
  const total = result.stages.length;
  return (
    <div className="canvas__picking-banner canvas__sim-banner">
      <Play size={16} />
      <span>
        Simulating into <strong>{name ?? '?'}</strong>
        {current ? (
          <>
            {' '}
            · <span className="simulate__progress">stage {stage + 1}/{total}</span> {current.label}
          </>
        ) : total ? (
          <>
            {' '}
            · <span className="simulate__progress">raw inputs</span>
          </>
        ) : null}
      </span>
      <button className="btn btn--sm btn--icon btn--ghost" title="Back one stage" disabled={stage <= -1} onClick={() => step(-1)}>
        <ChevronLeft />
      </button>
      <button className="btn btn--sm btn--icon btn--ghost" title={playing ? 'Pause' : 'Play'} disabled={!total} onClick={() => (playing ? pause() : play())}>
        {playing ? <Pause /> : <Play />}
      </button>
      <button className="btn btn--sm btn--icon btn--ghost" title="Forward one stage" disabled={stage >= total - 1} onClick={() => step(1)}>
        <ChevronRight />
      </button>
      <button className="btn btn--sm btn--ghost" title="Open the Simulate tab" onClick={() => openDrawer('simulate')}>
        Rows
      </button>
      <button className="btn btn--sm btn--icon btn--ghost" title="Exit simulation (Esc)" onClick={() => stop()}>
        <X />
      </button>
    </div>
  );
}

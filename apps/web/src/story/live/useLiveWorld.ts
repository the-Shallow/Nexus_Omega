// While a live run is on, the world mirrors the real fleet instead of playing a script:
// a crashed worker is red, a drained one amber, and a worker shows silent only after
// the agent's own canary got 200 OK with no tool calls back.
import { useEffect } from 'react';
import type { World } from '../world/world';
import type { LiveFrame } from './useLiveFleet';
import type { LiveRun } from './useLiveRun';

export function useLiveWorld(world: World | null, run: LiveRun | null, frame: LiveFrame | null) {
  const on = !!run;
  useEffect(() => {
    if (!world || !on) return;
    world.clearTimers();
    world.ambientOn = false;
    world.finale(null);
    world.light({});
    world.setFog(18, 52);
    world.focus('gpu');
    world.cam('gpu', 2.4);
  }, [world, on]);

  useEffect(() => {
    if (!world || !run || !frame) return;
    const states: Record<string, string> = {};
    const drained: number[] = [];
    // The opening canary describes the fleet before the repair, so it stops counting once the referee has spoken.
    const early = run.phase === 'investigating' || run.phase === 'repairing';
    world.fleet.forEach((w, i) => {
      const f = frame.workers.find((x) => x.id === w.id);
      if (!f) return;
      const c = run.canary[w.id];
      if (f.draining) drained.push(i);
      const look = f.state === 'crashed' ? 'bad' : f.draining ? 'drain' : early && c && !c.count && c.status === 200 ? 'silent' : f.state === 'ready' ? 'ok' : null;
      if (look) states[w.id] = look;
    });
    states.gateway = drained.length ? `drain:${drained.join(',')}` : 'ok';
    if (frame.kpi.slo_ok !== null && frame.kpi.slo_ok !== undefined) states.dash = frame.kpi.slo_ok ? 'ok' : 'bad';
    if (run.hidden !== null) states.canary = run.hidden ? 'pass' : 'fail';
    world.apply(states);
  }, [world, run, frame]);
}

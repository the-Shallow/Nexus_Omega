// Plays back a recorded run of the Nemotron agent on the real fleet, in recorded
// time. Play, pause, speed and seeking move replay time only. Long silent gaps
// (the executor restarting a worker) can be compressed; the UI says so while it
// happens, and the clock always shows the recorded wall time.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { fleetBounds, fleetTimeline, ms, type FleetPhase } from './flow';
import type { RecordingDetail } from './types';

export interface FleetState {
  detail: RecordingDetail | null;
  loading: string | null;
  error: string | null;
  start: number;
  end: number;
  cursor: number;
  playing: boolean;
  speed: number;
  compress: boolean;
  /** True while an idle gap is being skipped faster than the chosen speed. */
  fast: boolean;
}

const FAST = 12;
let state: FleetState = { detail: null, loading: null, error: null, start: 0, end: 0, cursor: 0, playing: false, speed: 1, compress: true, fast: false };
const subs = new Set<() => void>();
let marks: number[] = [];
let raf = 0;
let last = 0;

function set(patch: Partial<FleetState>) {
  state = { ...state, ...patch };
  subs.forEach((s) => s());
}

function loop(now: number) {
  raf = 0;
  const s = state;
  if (!s.detail || !s.playing) return;
  const dt = Math.min(now - last, 100);
  last = now;
  const next = marks.find((m) => m > s.cursor) ?? s.end;
  const fast = s.compress && next - s.cursor > 2600;
  let cursor = s.cursor + dt * s.speed * (fast ? FAST : 1);
  if (fast) cursor = Math.min(cursor, next - 1200);
  if (cursor >= s.end) { set({ cursor: s.end, playing: false, fast: false }); return; }
  set({ cursor, fast });
  raf = requestAnimationFrame(loop);
}

function kick() {
  last = performance.now();
  if (!raf && state.playing) raf = requestAnimationFrame(loop);
}

export const fleet = {
  get: () => state,
  subscribe(l: () => void) { subs.add(l); return () => { subs.delete(l); }; },
  async start(id: string) {
    set({ loading: id, error: null });
    try {
      const detail = await api.recording(id);
      const { start, end } = fleetBounds(detail);
      marks = fleetTimeline(detail).map((e) => e.t);
      set({ detail, loading: null, start, end, cursor: start, playing: true, speed: 1, fast: false });
      kick();
    } catch (e) {
      set({ loading: null, error: (e as Error).message });
      throw e;
    }
  },
  restart() {
    if (!state.detail) return;
    set({ cursor: state.start, playing: true, fast: false });
    kick();
  },
  setPlaying(playing: boolean) {
    if (!state.detail) return;
    set({ playing, cursor: playing && state.cursor >= state.end ? state.start : state.cursor });
    kick();
  },
  setSpeed(speed: number) { set({ speed }); },
  setCompress(compress: boolean) { set({ compress }); },
  seek(cursor: number) { set({ cursor: Math.max(state.start, Math.min(state.end, cursor)), fast: false }); },
  exit() {
    cancelAnimationFrame(raf);
    raf = 0;
    set({ detail: null, playing: false, fast: false, error: null });
  },
};

export function useFleet<T>(selector: (s: FleetState) => T): T {
  return useSyncExternalStore(fleet.subscribe, () => selector(state));
}

/** Number of recorded moments at or before the cursor: changes only when something happens. */
export function stepAt(rec: RecordingDetail, cursor: number): number {
  let n = 0;
  for (const e of fleetTimeline(rec)) { if (e.t > cursor) break; n++; }
  return n;
}

// ------------------------------------------------------------------ fleet view model

export type FleetIssue = 'canary' | 'link' | 'down';
export interface FleetWorker {
  id: string;
  canary: 'ok' | 'bad' | 'unknown';
  parser: string | null;
  template: string | null;
  profile: string | null;
  /** Why the worker looks faulty, from recorded evidence only. */
  issue: FleetIssue | null;
  state: 'serving' | 'faulty' | 'repairing' | 'repaired' | 'drained' | 'unresolved';
}
export interface FleetView {
  phase: FleetPhase;
  focus: string | null;
  focusAt: number;
  workers: FleetWorker[];
  route: Record<string, { p95: number; err: number; ok: boolean }>;
  repair: { start: number; end: number; progress: number; target: string; seconds: number; action: string } | null;
  referee: boolean;
}

const WORKER_IDS = ['target-a', 'target-b'];
const alias = (k: string) => (k.length === 1 ? `target-${k}` : k);
const RANK: Record<FleetIssue, number> = { canary: 1, link: 2, down: 3 };

/** What the recorded fleet looked like at the cursor, from recorded evidence only. */
export function fleetView(rec: RecordingDetail, cursor: number): FleetView {
  const tl = fleetTimeline(rec);
  let phase: FleetPhase = 'detect', focus: string | null = null, focusAt = 0;
  for (const e of tl) {
    if (e.t > cursor) break;
    if (e.phase) phase = e.phase;
    if (e.focus !== undefined && e.focus !== null) { focus = e.focus; focusAt = e.t; }
  }
  const workers: Record<string, FleetWorker> = Object.fromEntries(WORKER_IDS.map((id) => [id, { id, canary: 'unknown', parser: null, template: null, profile: null, issue: null, state: 'serving' } as FleetWorker]));
  const flag = (id: string, issue: FleetIssue) => {
    const w = workers[id];
    if (w && (!w.issue || RANK[issue] > RANK[w.issue])) w.issue = issue;
  };
  const route: FleetView['route'] = {};
  // An evidence document counts from the moment the trail recorded it.
  const recordedAt = new Map<string, number>();
  for (const e of rec.events) if (e.event_type === 'evidence_recorded' && e.payload?.evidence?.evidence_id) recordedAt.set(e.payload.evidence.evidence_id, ms(e.timestamp));
  for (const row of rec.evidence_index ?? []) {
    const at = recordedAt.get(row.evidence_id);
    if (at == null || at > cursor) continue;
    const c = rec.evidence[row.evidence_id]?.content;
    const d = c?.data;
    if (d?.probe_id?.startsWith('tool-call') && workers[d.resource_id]) {
      const ok = (d.structured_tool_call_count ?? 0) > 0;
      workers[d.resource_id].canary = ok ? 'ok' : 'bad';
      if (!ok) flag(d.resource_id, 'canary');
    } else if (d?.probe_id === 'route-probe') {
      for (const [k, w] of Object.entries<any>(d.workers ?? {})) {
        route[alias(k)] = { p95: w.p95_s, err: w.error_rate, ok: !!w.ok };
        if (w.ok === false) flag(alias(k), 'link');
      }
    } else if (c?.configuration && workers[c.resource_id]) {
      workers[c.resource_id].parser = c.configuration.tool_call_parser ?? null;
      workers[c.resource_id].template = c.configuration.chat_template ?? null;
      if (c.configuration.container_state && c.configuration.container_state !== 'running') flag(c.resource_id, 'down');
    } else if (c?.state && workers[c.resource_id]) {
      if (c.state.container_state && c.state.container_state !== 'running') flag(c.resource_id, 'down');
    }
  }
  for (const w of Object.values(workers)) if (w.issue) w.state = 'faulty';

  let repair: FleetView['repair'] = null;
  const x = rec.episode?.executor;
  const startEntry = tl.find((e) => e.item?.id === 'x-start');
  const endEntry = tl.find((e) => e.item?.id === 'x-end');
  if (x && startEntry && endEntry && cursor >= startEntry.t) {
    const progress = Math.min(1, (cursor - startEntry.t) / (endEntry.t - startEntry.t));
    repair = { start: startEntry.t, end: endEntry.t, progress, target: x.service, seconds: x.seconds, action: x.action };
    const w = workers[x.service];
    if (w) {
      if (x.action === 'drain_worker') w.state = 'drained';
      else if (progress < 1) w.state = 'repairing';
      else if (x.verification?.passed) { w.state = 'repaired'; w.canary = 'ok'; w.profile = x.profile ?? null; }
      else w.state = 'faulty';
    }
  }
  const s = rec.summary;
  const v = rec.episode?.verification;
  const refEntry = tl.find((e) => e.item?.id === 'ref-0');
  const referee = !!(v && refEntry && cursor >= refEntry.t);
  if (referee && v) {
    for (const [k, r] of Object.entries(v.route ?? {})) route[alias(k)] = { p95: r.p95_s, err: r.error_rate, ok: r.ok };
    // The referee has the last word: a "repaired" worker that still fails its probe is not repaired.
    if (!s.success) {
      for (const w of Object.values(workers)) {
        const r = route[w.id];
        if (w.state !== 'drained' && (w.issue || (r && !r.ok))) w.state = 'unresolved';
      }
    }
  }
  return { phase, focus, focusAt, workers: WORKER_IDS.map((id) => workers[id]), route, repair, referee };
}

// One store for everything streamed from the twin. The 3D scene subscribes to raw
// frames (60 fps render loop, 10 Hz data) without going through React; React
// components read slices with useStore().
//
// Data modes are explicit:
//   simulated  frames come from the SimPy twin over the WebSocket
//   live       frames come from production telemetry (not connected in this build)
//   replay     recorded frames of a finished incident are played back
import { useSyncExternalStore } from 'react';
import type { DataMode, DoctorSnapshot, Frame, Topology } from './types';

interface Recorded { frame: Frame; doctor: DoctorSnapshot | null }

export interface Recording {
  id: string;
  label: string;
  frames: Recorded[];
}

export interface ReplayState {
  recording: Recording;
  index: number;
  playing: boolean;
  speed: number;
}

export interface State {
  connected: boolean;
  source: 'twin' | 'live' | null;
  topo: Topology | null;
  frame: Frame | null;
  doctor: DoctorSnapshot | null;
  mode: DataMode;
  replay: ReplayState | null;
  recording: Recording | null;
  autopilot: boolean;
}

const PRE_ROLL = 60; // frames kept before an incident starts (6 s)
const POST_ROLL_S = 8; // twin seconds recorded after the run ends
const MAX_FRAMES = 3600;

let state: State = {
  connected: false, source: null, topo: null, frame: null, doctor: null,
  mode: 'simulated', replay: null, recording: null, autopilot: true,
};
const listeners = new Set<() => void>();
const frameListeners = new Set<(f: Frame, mode: DataMode) => void>();
const topoListeners = new Set<(t: Topology) => void>();

let liveFrame: Frame | null = null;
let liveDoctor: DoctorSnapshot | null = null;
const preRoll: Recorded[] = [];
let capture: { frames: Recorded[]; endAt: number | null; label: string; id: string; runId: string | null } | null = null;
let replayTimer: number | null = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function display(frame: Frame, doctor: DoctorSnapshot | null, mode: DataMode) {
  frameListeners.forEach((l) => l(frame, mode));
  set({ frame, doctor, mode });
}

// --------------------------------------------------------------- recording

// Captures one incident: a short pre-roll, the fault, the doctor run that answers
// it, and a few seconds after the run ends. Snapshots of earlier runs are not
// recorded, so a replay never shows a previous incident's state.
function record(frame: Frame, doctor: DoctorSnapshot | null) {
  const open = frame.faults.some((f) => f.resolved_at == null);
  const fresh = doctor && !doctor.terminal ? doctor : null;
  if (!capture) {
    preRoll.push({ frame, doctor: null });
    if (preRoll.length > PRE_ROLL) preRoll.shift();
    if (open || fresh) {
      const label = frame.faults.find((f) => f.resolved_at == null)?.title ?? fresh?.incident.title ?? 'Incident';
      capture = { frames: [...preRoll], endAt: null, label, id: `${Math.round(frame.t)}`, runId: fresh?.id ?? null };
      preRoll.length = 0;
    }
    return;
  }
  if (!capture.runId && fresh) capture.runId = fresh.id;
  const mine = capture.runId && doctor?.id === capture.runId ? doctor : null;
  capture.frames.push({ frame, doctor: mine });
  if (mine?.incident.title) capture.label = mine.incident.title;
  const settled = mine ? !!mine.terminal : !capture.runId && !open;
  if (settled && capture.endAt == null) capture.endAt = frame.t + POST_ROLL_S;
  if (!settled) capture.endAt = null;
  if ((capture.endAt != null && frame.t >= capture.endAt) || capture.frames.length >= MAX_FRAMES) {
    if (capture.runId) set({ recording: { id: capture.id, label: capture.label, frames: capture.frames } });
    capture = null;
  }
}

// --------------------------------------------------------------- socket

function connect(delay = 500) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => set({ connected: true });
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'hello') {
      set({ topo: data.topology, source: data.source === 'live' ? 'live' : 'twin' });
      topoListeners.forEach((l) => l(data.topology));
      return;
    }
    const frame = data as Frame;
    if ('doctor' in frame) liveDoctor = frame.doctor ?? null;
    liveFrame = frame;
    if (frame.doctors && frame.doctors.autopilot !== state.autopilot) set({ autopilot: frame.doctors.autopilot });
    record(frame, liveDoctor);
    if (!state.replay) display(frame, liveDoctor, state.source === 'live' ? 'live' : 'simulated');
  };
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(() => connect(Math.min(delay * 2, 5000)), delay);
  };
}

// --------------------------------------------------------------- replay

function stepReplay() {
  const r = state.replay;
  if (!r || !r.playing) return;
  const next = r.index + 1;
  if (next >= r.recording.frames.length) {
    set({ replay: { ...r, playing: false } });
    return;
  }
  const item = r.recording.frames[next];
  state = { ...state, replay: { ...r, index: next } };
  display(item.frame, item.doctor, 'replay');
}

function scheduleReplay() {
  if (replayTimer != null) clearInterval(replayTimer);
  replayTimer = null;
  const r = state.replay;
  if (r?.playing) replayTimer = window.setInterval(stepReplay, 100 / r.speed);
}

export const store = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  onFrame(l: (f: Frame, mode: DataMode) => void) { frameListeners.add(l); return () => frameListeners.delete(l); },
  onTopology(l: (t: Topology) => void) {
    topoListeners.add(l);
    if (state.topo) l(state.topo);
    return () => topoListeners.delete(l);
  },
  start() { connect(); },

  startReplay(speed = 1) {
    const recording = state.recording;
    if (!recording) return;
    set({ replay: { recording, index: 0, playing: true, speed } });
    const first = recording.frames[0];
    display(first.frame, first.doctor, 'replay');
    scheduleReplay();
  },
  setReplay(patch: Partial<Pick<ReplayState, 'playing' | 'speed' | 'index'>>) {
    const r = state.replay;
    if (!r) return;
    let index = patch.index ?? r.index;
    if (patch.playing && index >= r.recording.frames.length - 1) index = 0;
    set({ replay: { ...r, ...patch, index } });
    if (patch.index != null || index !== r.index) {
      const item = r.recording.frames[index];
      display(item.frame, item.doctor, 'replay');
    }
    scheduleReplay();
  },
  exitReplay() {
    set({ replay: null });
    scheduleReplay();
    if (liveFrame) display(liveFrame, liveDoctor, state.source === 'live' ? 'live' : 'simulated');
  },
  clearLiveDoctor() { liveDoctor = null; capture = null; preRoll.length = 0; },
};

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state));
}

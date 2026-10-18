import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { Architecture } from './components/Architecture';
import { CertificateOverlay, type CertRef } from './components/Certificate';
import { ChaosOverlay } from './components/ChaosOverlay';
import { Dock, ReplayStrip } from './components/Dock';
import { FleetStage } from './components/FleetStage';
import { Boot, Capsule, ContinueBar, Disconnected, IncidentHint, Telemetry, Toasts } from './components/Overlays';
import { TwinCanvas, type TwinLayout } from './components/TwinCanvas';
import { Workflow } from './components/Workflow';
import { api } from './lib/api';
import { toast, twin } from './lib/bus';
import { fleet, stepAt, useFleet } from './lib/fleet';
import { fromFleet, fromTwin } from './lib/flow';
import { store, useStore } from './lib/store';
import type { FaultSpec } from './lib/types';

const WORKFLOW_W = 420;
const CHAOS_W = 560;

function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

/**
 * The War Room. One page; every transition is driven by a real state change:
 * a fault in the twin's frames, a doctor run's events, a recorded run's timeline.
 */
export default function App() {
  const run = useStore((s) => s.doctor);
  const mode = useStore((s) => s.mode);
  const connected = useStore((s) => s.connected);
  const recording = useStore((s) => s.recording);
  const replaying = useStore((s) => !!s.replay);
  const openFault = useStore((s) => s.frame?.faults.find((f) => f.resolved_at == null) ?? null);
  const twinT = useStore((s) => s.frame?.t ?? 0);
  const fleetRec = useFleet((s) => s.detail);
  const fleetStep = useFleet((s) => (s.detail ? stepAt(s.detail, s.cursor) : -1));
  const { w: vw, h: vh } = useViewport();

  const [chaos, setChaos] = useState(false);
  const [arch, setArch] = useState(false);
  const [cert, setCert] = useState<CertRef | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [continueFor, setContinueFor] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<FaultSpec[]>([]);
  const [lastFault, setLastFault] = useState<FaultSpec | null>(null);
  const firstSight = useRef<string | null | undefined>(undefined);
  const celebrated = useRef(new Set<string>());

  useEffect(() => { api.faults().then(setCatalog).catch(() => undefined); }, []);

  // A run that had already ended before this page opened is history, not an incident.
  if (firstSight.current === undefined && run && mode !== 'replay') firstSight.current = run.terminal ? run.id : null;

  const twinFlow = useMemo(() => {
    if (!run || (mode !== 'replay' && run.id === firstSight.current)) return null;
    const f = fromTwin(run);
    return mode === 'replay' ? { ...f, key: `replay:${f.key}` } : f;
  }, [run, mode]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fleetFlow = useMemo(() => (fleetRec ? fromFleet(fleetRec, fleet.get().cursor) : null), [fleetRec, fleetStep]);
  const flowAny = fleetFlow ?? twinFlow;
  const flow = flowAny && flowAny.key !== dismissed ? flowAny : null;
  const showFlow = !!flow && !chaos;

  // VERIFIED in the twin: a restoration wave sweeps the hall, once.
  useEffect(() => {
    if (!twinFlow || fleetFlow || twinFlow.terminal !== 'VERIFIED' || celebrated.current.has(twinFlow.key)) return;
    celebrated.current.add(twinFlow.key);
    twin.get()?.recoveryWave();
  }, [twinFlow?.key, twinFlow?.terminal, fleetFlow]); // eslint-disable-line react-hooks/exhaustive-deps

  const mobile = vw < 768;
  const panel = Math.min(WORKFLOW_W, vw - 24) + 28;
  const layout: TwinLayout = useMemo(() => {
    if (fleetRec) return { zoom: 0.8, shift: mobile ? 0 : 0.17, dim: 0, standby: true };
    let l: TwinLayout = { zoom: 1, shift: 0, dim: 0, standby: false };
    if (chaos) l = { zoom: 0.9, shift: mobile ? 0 : (Math.min(CHAOS_W, vw - 24) + 16) / 2 / vw, dim: 0.12, standby: false };
    // On a phone the workflow is a bottom sheet: the hall moves up into the top half instead of left.
    else if (showFlow) l = mobile ? { zoom: 1, shift: 0, lift: 0.27, dim: 0, standby: false } : { zoom: 0.86, shift: panel / 2 / vw, dim: 0, standby: false };
    if (cert || arch) l = { ...l, dim: 0.5 };
    return l;
  }, [fleetRec, chaos, showFlow, cert, arch, vw, mobile, panel]);

  const busy = run && !run.terminal && mode !== 'replay' ? 'A recovery is in progress' : null;
  const breakDisabled = !connected ? 'The twin is offline' : busy;
  const openChaos = useCallback(() => { if (!breakDisabled) { setArch(false); setCert(null); setChaos(true); } }, [breakDisabled]);

  const reset = useCallback(async () => {
    if (fleet.get().detail) fleet.exit();
    if (store.get().replay) store.exitReplay();
    try {
      await api.control({ reset: true, speed: 1, paused: false });
      store.clearLiveDoctor();
      setDismissed(null); setContinueFor(null); setCert(null);
      toast('Twin reset to a healthy fleet');
    } catch (e) { toast((e as Error).message, 'bad'); }
  }, []);

  const injected = useCallback((f: FaultSpec) => {
    setLastFault(f);
    if (flowAny) setDismissed(flowAny.key);
    setContinueFor(null);
    toast(`${f.title} injected`, 'bad', 2600);
  }, [flowAny]);

  const closeCert = useCallback(() => { setCert(null); if (flow?.terminal) setContinueFor(flow.key); }, [flow]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [role=dialog]') || chaos || cert || arch || e.metaKey || e.ctrlKey) return;
      if (e.key === 'b' || e.key === 'B') openChaos();
      else if (e.key === ' ') {
        e.preventDefault();
        if (fleet.get().detail) fleet.setPlaying(!fleet.get().playing);
        else if (store.get().replay) store.setReplay({ playing: !store.get().replay!.playing });
        else api.control({ paused: !store.get().frame?.paused });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [chaos, cert, arch, openChaos]);

  // "Run again": a genuinely new execution of the same failure on a fresh twin, never a replay.
  const again = useMemo(() => {
    if (!flow || flow.source !== 'twin') return null;
    return lastFault?.title === flow.title ? lastFault : catalog.find((f) => f.title === flow.title) ?? null;
  }, [flow, lastFault, catalog]);
  const runAgain = async () => {
    if (!again) return;
    if (store.get().replay) store.exitReplay();
    try {
      await api.control({ reset: true, speed: 1, paused: false });
      store.clearLiveDoctor();
      if (flow) setDismissed(flow.key);
      setContinueFor(null);
      await api.inject(again.kind);
      setLastFault(again);
      toast(`${again.title} injected again · new execution`, 'bad', 2600);
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const replayIt = () => {
    setContinueFor(null);
    if (flow?.source === 'fleet') fleet.restart();
    else if (recording) { setDismissed(null); store.startReplay(); }
  };

  const hintShow = !!openFault && !fleetRec && !chaos && !(run && run.states[0] && run.states[0].t >= openFault.t - 0.5);
  const continueShow = !!flow?.terminal && continueFor === flow.key && !cert && !chaos && !arch;

  return (
    <MotionConfig reducedMotion="user">
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <TwinCanvas layout={layout} />
      {/* Atmosphere: a vignette that keeps the eye on the hall and the glass legible. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_95%_at_45%_48%,transparent_50%,rgba(3,4,5,0.88))]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/55 to-transparent" />

      <FleetStage />
      <Telemetry hidden={!!fleetRec || chaos || continueShow} />
      <Capsule disabled={!!fleetRec || chaos} />
      <IncidentHint show={hintShow} title={openFault?.title ?? ''} since={openFault ? twinT - openFault.t : 0} />

      <Workflow
        flow={showFlow ? flow : null}
        top={mobile ? Math.round(vh * 0.46) : replaying || fleetRec ? 132 : 88}
        onCertificate={() => flow?.certificate && setCert(flow.certificate)}
        onArchitecture={() => setArch(true)}
        onDismiss={() => { if (flow) setDismissed(flow.key); setContinueFor(null); }}
      />
      <ContinueBar
        show={continueShow}
        right={showFlow && !mobile ? panel + 8 : 24}
        actions={[
          { key: 'replay', label: flow?.source === 'fleet' ? 'Replay recording' : 'Replay simulation', icon: <IconReplay />, onClick: replayIt, disabled: flow?.source === 'fleet' ? null : recording ? null : 'The recording finishes a few seconds after the run ends' },
          { key: 'new', label: 'Start new failure', icon: <IconBolt />, onClick: openChaos, disabled: breakDisabled, primary: true },
          { key: 'again', label: 'Run again', icon: <IconAgain />, onClick: runAgain, disabled: flow?.source === 'fleet' ? 'Re-running on the real fleet needs its operator fault endpoint, which is not connected to this UI' : again ? null : 'Unknown failure kind' },
          { key: 'arch', label: 'Architecture', icon: <IconArch />, onClick: () => setArch(true) },
        ]}
      />

      <Dock onBreak={openChaos} breakDisabled={breakDisabled} onArchitecture={() => setArch(true)} onReset={reset} />
      <ReplayStrip />
      <Toasts />
      <Disconnected />

      <ChaosOverlay open={chaos} onClose={() => setChaos(false)} onInjected={injected} onReplay={() => { if (twinFlow) setDismissed(twinFlow.key); setContinueFor(null); }} />
      <CertificateOverlay cert={cert} onClose={closeCert} />
      <Architecture open={arch} flow={flowAny} onClose={() => setArch(false)} />
      <Boot />
    </div>
    </MotionConfig>
  );
}

const I = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const IconReplay = () => <I d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />;
const IconBolt = () => <svg viewBox="0 0 24 24" className="size-4 fill-[#ff6b81]"><path d="M13.4 2 4.6 13.5h6.2L9.8 22l8.8-11.6h-6.1z" /></svg>;
const IconAgain = () => <I d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />;
const IconArch = () => <I d="M4 6h4v4H4zM16 4h4v4h-4zM16 16h4v4h-4zM8 8h3a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M13 10V8a2 2 0 0 1 2-2h1" />;

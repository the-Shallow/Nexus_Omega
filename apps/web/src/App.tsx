import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { ArchPanel, type ArchHead } from './components/ArchPanel';
import { BreakSheet } from './components/BreakSheet';
import { CertificateOverlay, type CertRef } from './components/Certificate';
import { Dock, ReplayStrip } from './components/Dock';
import { Boot, Capsule, ContinueBar, Disconnected, Toasts } from './components/Overlays';
import { Traces } from './components/Traces';
import { TwinCanvas, type TwinLayout } from './components/TwinCanvas';
import { replicaTone, WarRoom, type HoloBox } from './components/WarRoom';
import { Workflow } from './components/Workflow';
import { api } from './lib/api';
import { buildArch, type ArchContext, type ReplicaTone } from './lib/arch';
import { toast, twin } from './lib/bus';
import { fleet, fleetView, stepAt, useFleet, type FleetWorker } from './lib/fleet';
import { fromFleet, fromTwin, modelName, type FlowRun } from './lib/flow';
import { store, useStore } from './lib/store';
import type { FaultRecord, FaultSpec } from './lib/types';

type Origin = { x: number; y: number };
const SHEET_W = 500;

function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

const FLEET_TONE: Record<FleetWorker['state'], ReplicaTone> = { serving: 'ok', repaired: 'ok', faulty: 'bad', unresolved: 'bad', repairing: 'info', drained: 'off' };

/**
 * The War Room. One page, one continuous experience: the holographic War Room and
 * the hall → break → the hall takes the hit → the recovery architecture assembles
 * on the right → verify → certificate → replay or a new failure. Every transition
 * follows a real state change: a fault in the twin's frames, a doctor run's events,
 * a recorded run's timeline.
 */
export default function App() {
  const run = useStore((s) => s.doctor);
  const mode = useStore((s) => s.mode);
  const connected = useStore((s) => s.connected);
  const recording = useStore((s) => s.recording);
  const replaying = useStore((s) => !!s.replay);
  const openFault = useStore((s) => s.frame?.faults.find((f) => f.resolved_at == null) ?? null);
  const twinT = useStore((s) => s.frame?.t ?? 0);
  const replicaSig = useStore((s) => s.frame?.workers.map((w) => `${w.id}:${replicaTone(w)}`).join('|') ?? '');
  const fleetRec = useFleet((s) => s.detail);
  const fleetStep = useFleet((s) => (s.detail ? stepAt(s.detail, s.cursor) : -1));
  const fleetSig = useFleet((s) => (s.detail ? fleetView(s.detail, s.cursor).workers.map((w) => `${w.id}:${FLEET_TONE[w.state]}`).join('|') : ''));
  const { w: vw, h: vh } = useViewport();

  const [chaos, setChaos] = useState<Origin | null>(null);
  const [cert, setCert] = useState<CertRef | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [continueFor, setContinueFor] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<FaultSpec[]>([]);
  const [lastFault, setLastFault] = useState<FaultSpec | null>(null);
  const [beat, setBeat] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const firstSight = useRef<string | null | undefined>(undefined);
  const celebrated = useRef(new Set<string>());
  const faultMem = useRef<FaultRecord | null>(null);

  useEffect(() => { api.faults().then(setCatalog).catch(() => undefined); }, []);

  // A run that had already ended before this page opened is history, not an incident.
  if (firstSight.current === undefined && run && mode !== 'replay') firstSight.current = run.terminal ? run.id : null;
  if (openFault && openFault.id !== faultMem.current?.id) faultMem.current = openFault;

  const twinFlow = useMemo(() => {
    if (!run || (mode !== 'replay' && run.id === firstSight.current)) return null;
    const f = fromTwin(run);
    return mode === 'replay' ? { ...f, key: `replay:${f.key}` } : f;
  }, [run, mode]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fleetFlow = useMemo(() => (fleetRec ? fromFleet(fleetRec, fleet.get().cursor) : null), [fleetRec, fleetStep]);

  // The episode on stage: a recorded fleet run, a twin replay, or the twin's latest incident and its run.
  let key: string | null = null, flow: FlowRun | null = null, fault: FaultRecord | null = null;
  if (fleetRec) { key = `fleet:${fleetRec.summary.id}:${nonce}`; flow = fleetFlow; }
  else if (mode === 'replay') { if (twinFlow) { key = `${twinFlow.key}:${nonce}`; flow = twinFlow; } }
  else {
    const mem = faultMem.current;
    const runStart = run?.states[0]?.t;
    if (twinFlow && mem && runStart != null && runStart >= mem.t - 1) { key = `fault:${mem.id}`; flow = twinFlow; fault = mem; }
    else if (openFault) { key = `fault:${openFault.id}`; fault = openFault; }
    else if (twinFlow) { key = twinFlow.key; flow = twinFlow; }
  }
  const visible = !!key && key !== dismissed;

  // A beat for the hit to land before the hall makes room for the architecture.
  useEffect(() => {
    if (!key || beat === key) return;
    const t = setTimeout(() => setBeat(key), key.startsWith('fault:') && !flow ? 1900 : 700);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const engaged = visible && beat === key;

  // VERIFIED in the twin: a restoration wave sweeps the hall, once.
  useEffect(() => {
    if (!twinFlow || fleetRec || twinFlow.terminal !== 'VERIFIED' || celebrated.current.has(twinFlow.key)) return;
    celebrated.current.add(twinFlow.key);
    twin.get()?.recoveryWave();
  }, [twinFlow?.key, twinFlow?.terminal, fleetRec]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ architecture model
  const incidentTitle = fault?.title ?? flow?.title ?? null;
  const ctx: ArchContext | null = useMemo(() => {
    if (!key) return null;
    if (fleetRec) {
      const s = fleetRec.summary;
      return {
        source: 'fleet', faultKind: s.fault, faultTargets: [s.target, ...(s.remedy?.fix ?? []), ...(s.remedy?.drain ?? [])].filter((x): x is string => !!x),
        replicas: fleetSig.split('|').filter(Boolean).map((p) => { const [id, tone] = p.split(':'); return { id, tone: tone as ReplicaTone }; }),
        controller: modelName(s.controller), controllerReal: true,
      };
    }
    const inc = run?.incident;
    const targets = fault ? (fault.targets?.length ? fault.targets : fault.target ? [fault.target] : []) : inc?.targets?.length ? inc.targets : inc?.target ? [inc.target] : [];
    return {
      source: 'twin', faultKind: fault?.kind ?? catalog.find((f) => f.title === incidentTitle)?.kind ?? null, faultTargets: targets,
      replicas: replicaSig.split('|').filter(Boolean).map((p) => { const [id, tone] = p.split(':'); return { id, tone: tone as ReplicaTone }; }),
      controller: run?.controller ?? 'rule-based stand-in', controllerReal: false,
    };
  }, [key, fleetRec, fleetSig, replicaSig, fault, run?.incident, run?.controller, catalog, incidentTitle]); // eslint-disable-line react-hooks/exhaustive-deps
  const model = useMemo(() => (engaged && ctx ? buildArch(flow, ctx) : null), [engaged, ctx, flow]);
  const head: ArchHead | null = ctx && incidentTitle ? {
    title: incidentTitle,
    target: flow?.target ?? (ctx.faultTargets.length > 1 ? `${ctx.faultTargets.length} targets` : ctx.faultTargets[0] ?? null),
    controller: ctx.controller, controllerReal: ctx.controllerReal, source: ctx.source,
  } : null;

  // ------------------------------------------------------------------ layout
  const mobile = vw < 768;
  const panelW = Math.round(Math.min(780, Math.max(430, vw * 0.41)));
  const sheetW = Math.min(SHEET_W, vw - 24);
  const showArch = engaged && !chaos && !mobile;
  const showSheetMobile = engaged && !chaos && mobile && !!flow;
  const leftW = showArch ? vw - panelW - 12 : chaos && !mobile ? vw - sheetW - 12 : vw;

  const layout: TwinLayout = useMemo(() => {
    let l: TwinLayout;
    if (mobile) l = showSheetMobile ? { zoom: 1, shift: 0, lift: 0.27, dim: 0, standby: false } : { zoom: 0.96, shift: 0, lift: -0.12, dim: 0, standby: false };
    else if (showArch || (chaos && !mobile)) {
      const right = vw - leftW;
      l = { zoom: 0.66, shift: right / 2 / vw, lift: -0.17, dim: chaos ? 0.12 : 0, standby: false };
    } else l = { zoom: 0.72, shift: 0, lift: -0.145, dim: 0, standby: false };
    if (fleetRec) l = { ...l, standby: true };
    if (cert) l = { ...l, dim: 0.5 };
    return l;
  }, [mobile, showSheetMobile, showArch, chaos, vw, leftW, fleetRec, cert]);

  const holo: HoloBox = useMemo(() => {
    if (mobile) return showSheetMobile || fleetRec ? { left: 12, top: 84, width: vw - 24, height: 52, compact: true, strip: true } : { left: 12, top: 84, width: vw - 24, height: 190, compact: true };
    const width = Math.min(showArch || chaos ? 860 : 1100, leftW - 56);
    const height = Math.round(Math.max(200, Math.min(showArch || chaos ? 270 : 320, vh * (showArch || chaos ? 0.28 : 0.33))));
    return { left: Math.round((leftW - width) / 2), top: 92, width, height, compact: width < 760 };
  }, [mobile, vw, vh, leftW, showArch, chaos, showSheetMobile, fleetRec]);

  // ------------------------------------------------------------------ actions
  const busy = run && !run.terminal && mode !== 'replay' ? 'A recovery is in progress' : null;
  const breakDisabled = !connected ? 'The twin is offline' : busy;
  const openChaos = useCallback((origin?: Origin) => { if (!breakDisabled) { setCert(null); setChaos(origin ?? { x: vw - 80, y: 44 }); } }, [breakDisabled, vw]);

  const resetTwin = useCallback(async () => {
    await api.control({ reset: true, speed: 1, paused: false });
    store.clearLiveDoctor();
    faultMem.current = null;
  }, []);

  const reset = useCallback(async () => {
    if (fleet.get().detail) fleet.exit();
    if (store.get().replay) store.exitReplay();
    try {
      await resetTwin();
      setDismissed(key); setContinueFor(null); setCert(null);
      toast('Twin reset to a healthy fleet');
    } catch (e) { toast((e as Error).message, 'bad'); }
  }, [key, resetTwin]);

  // Start new failure: back to a healthy fleet (confirmed by the backend), then choose again.
  const startNew = useCallback(async (origin?: Origin) => {
    if (fleet.get().detail) fleet.exit();
    if (store.get().replay) store.exitReplay();
    try {
      await resetTwin();
      setDismissed(key); setContinueFor(null); setCert(null);
      setChaos(origin ?? { x: vw / 2, y: vh - 60 });
    } catch (e) { toast(`Could not reset the twin: ${(e as Error).message}`, 'bad'); }
  }, [key, resetTwin, vw, vh]);

  const injected = useCallback((f: FaultSpec) => {
    setLastFault(f);
    if (key) setDismissed(key);
    setContinueFor(null);
    toast(`${f.title} injected`, 'bad', 2600);
  }, [key]);

  const closeCert = useCallback(() => { setCert(null); if (flow?.terminal && key) setContinueFor(key); }, [flow, key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [role=dialog]') || chaos || cert || e.metaKey || e.ctrlKey) return;
      if (e.key === 'b' || e.key === 'B') openChaos();
      else if (e.key === ' ') {
        e.preventDefault();
        if (fleet.get().detail) fleet.setPlaying(!fleet.get().playing);
        else if (store.get().replay) store.setReplay({ playing: !store.get().replay!.playing });
        else if (store.get().mode !== 'live') api.control({ paused: !store.get().frame?.paused });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chaos, cert, openChaos]);

  // Run again: a new execution of the same failure on a fresh twin, never a replay.
  const again = useMemo(() => {
    if (!flow || flow.source !== 'twin') return null;
    return lastFault?.title === flow.title ? lastFault : catalog.find((f) => f.title === flow.title) ?? null;
  }, [flow, lastFault, catalog]);
  const runAgain = async () => {
    if (!again) return;
    if (store.get().replay) store.exitReplay();
    try {
      await resetTwin();
      if (key) setDismissed(key);
      setContinueFor(null);
      await api.inject(again.kind);
      setLastFault(again);
      toast(`${again.title} injected again · new execution`, 'bad', 2600);
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const replayIt = () => {
    setContinueFor(null);
    setNonce((n) => n + 1);
    if (flow?.source === 'fleet') fleet.restart();
    else if (recording) { setDismissed(null); store.startReplay(); }
  };

  const continueShow = !!flow?.terminal && continueFor === key && !cert && !chaos;
  const bottomRight = showArch ? panelW + 24 : 24;
  const incident = fault && !fleetRec ? { title: fault.title, since: twinT - fault.t, detected: !!flow } : null;

  return (
    <MotionConfig reducedMotion="user">
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_60%_at_50%_18%,rgba(40,90,140,0.22),transparent_70%),radial-gradient(70%_60%_at_50%_100%,rgba(20,50,80,0.25),transparent_70%)]" />
      <TwinCanvas layout={layout} />
      {/* Atmosphere: a vignette that keeps the eye on the hall and the glass legible. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(130%_100%_at_45%_55%,transparent_55%,rgba(2,5,10,0.82))]" />

      <WarRoom box={holo} dim={cert ? 0.55 : chaos ? 0.25 : 0} onBreak={openChaos} breakDisabled={breakDisabled} incident={incident} />
      <Capsule disabled={!!fleetRec || !!chaos} />

      <ArchPanel
        show={showArch}
        episodeKey={key}
        model={model}
        flow={flow}
        head={head}
        width={panelW}
        top={84}
        onCertificate={() => flow?.certificate && setCert(flow.certificate)}
        onDismiss={() => { if (key) setDismissed(key); setContinueFor(null); }}
      />
      <Traces model={showArch && !cert ? model : null} faultTargets={ctx?.faultTargets ?? []} active={showArch && !fleetRec && !cert} />
      {/* Phones: the same run as a compact list in a bottom sheet. */}
      <Workflow
        flow={showSheetMobile ? flow : null}
        top={Math.round(vh * 0.46)}
        onCertificate={() => flow?.certificate && setCert(flow.certificate)}
        onDismiss={() => { if (key) setDismissed(key); setContinueFor(null); }}
      />
      <ContinueBar
        show={continueShow}
        right={bottomRight}
        lifted={!!fleetRec || replaying}
        actions={[
          { key: 'replay', label: flow?.source === 'fleet' ? 'Replay recording' : 'Replay simulation', hint: 'recorded · no new AI calls', icon: <IconReplay />, onClick: replayIt, disabled: flow?.source === 'fleet' ? null : recording ? null : 'The recording finishes a few seconds after the run ends' },
          { key: 'new', label: 'Start new failure', hint: 'reset to healthy · choose again', icon: <IconBolt />, onClick: () => startNew(), disabled: !connected ? 'The twin is offline' : null, primary: true },
          { key: 'again', label: 'Run again', hint: 'fresh twin · new execution · rule-based', icon: <IconAgain />, onClick: runAgain, disabled: flow?.source === 'fleet' ? 'Re-running on the real fleet needs its operator fault endpoint, which is not connected to this UI' : again ? null : 'Unknown failure kind' },
        ]}
      />

      <Dock onBreak={openChaos} breakDisabled={breakDisabled} onReset={reset} />
      <ReplayStrip right={bottomRight} />
      <Toasts />
      <Disconnected />

      <BreakSheet open={!!chaos} origin={chaos} onClose={() => setChaos(null)} onInjected={injected} onReplay={() => { if (key) setDismissed(key); setContinueFor(null); }} />
      <CertificateOverlay cert={cert} onClose={closeCert} />
      <Boot />
    </div>
    </MotionConfig>
  );
}

const I = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const IconReplay = () => <I d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />;
const IconBolt = () => <svg viewBox="0 0 24 24" className="size-4 fill-[#ff6b81]"><path d="M13.4 2 4.6 13.5h6.2L9.8 22l8.8-11.6h-6.1z" /></svg>;
const IconAgain = () => <I d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />;

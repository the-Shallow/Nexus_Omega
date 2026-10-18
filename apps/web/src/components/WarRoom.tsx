import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { fleetView, useFleet, type FleetWorker } from '../lib/fleet';
import { fleetVerdict, fromFleet, modelName, utc } from '../lib/flow';
import { ms, pct } from '../lib/format';
import { fleetStatus, systemStatus, TONE_HEX, TONE_TEXT, type SystemStatus } from '../lib/status';
import { store, useStore } from '../lib/store';
import type { Frame, Kpi, WorkerFrame } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

export interface HoloBox { left: number; top: number; width: number; height: number; compact: boolean; /** Header only (phones during a run). */ strip?: boolean }

/**
 * The War Room: one large holographic operations screen floating above the hall.
 * A sparse living topology, a few health signals, what the doctors are doing, and
 * the one control that matters. Everything on it is read from the twin's frames,
 * or from a recording while one replays.
 */
export function WarRoom({ box, dim, onBreak, breakDisabled, incident }: {
  box: HoloBox; dim: number; onBreak: (origin: { x: number; y: number }) => void; breakDisabled: string | null;
  incident: { title: string; since: number; detected: boolean } | null;
}) {
  const rec = useFleet((s) => s.detail);
  const reduce = !!useReducedMotion();
  return (
    <motion.section
      aria-label="War Room"
      className="pointer-events-none absolute z-[12]"
      initial={{ opacity: 0, y: -24, filter: 'blur(14px)' }}
      animate={{ opacity: 1 - dim, y: 0, filter: 'blur(0px)', left: box.left, top: box.top, width: box.width, height: box.height }}
      transition={{ opacity: { duration: 0.8 }, filter: { duration: 1.6, ease, delay: 0.5 }, y: { duration: 1.6, ease, delay: 0.5 }, default: { duration: 1.15, ease } }}
      style={{ perspective: 1600 }}
    >
      {/* Projection: the screen is light thrown up from the hall. */}
      <div className="holo-beam pointer-events-none absolute left-[12%] right-[12%] top-[96%] h-[46%]" />
      <div className="holo-screen absolute inset-0 overflow-hidden rounded-[26px]" style={{ transform: 'rotateX(7deg)', transformOrigin: '50% 100%' }}>
        <Brackets />
        <div className="holo-scan pointer-events-none absolute inset-0" />
        {!reduce && <div className="holo-sweep pointer-events-none absolute inset-0" />}
        <div className={`relative flex h-full flex-col px-5 pt-3.5 ${box.strip ? 'pb-3' : 'pb-11'}`}>
          {box.strip ? <StripHolo /> : rec ? <FleetHolo compact={box.compact} mini={box.width < 560} /> : <TwinHolo compact={box.compact} mini={box.width < 560} incident={incident} />}
        </div>
      </div>
      {!box.strip && <BreakControl onBreak={onBreak} disabled={breakDisabled} incident={incident} replay={!!rec} />}
    </motion.section>
  );
}

/** Phones during a run: just what is true right now. */
function StripHolo() {
  const connected = useStore((s) => s.connected);
  const frame = useStore((s) => s.frame);
  const run = useStore((s) => s.doctor);
  const mode = useStore((s) => s.mode);
  const rec = useFleet((s) => s.detail);
  const cursor = useFleet((s) => (s.detail ? Math.floor(s.cursor / 250) * 250 : 0));
  const status = rec ? fleetStatus(fromFleet(rec, cursor)) : systemStatus(connected, frame, run);
  const replay = !!rec || mode === 'replay';
  return <Head title="War Room" sub="" status={status} chip={replay ? 'Replay' : 'Simulated'} chipClass={replay ? 'border-replay/35 text-replay' : 'border-info/30 text-info'} />;
}

const Brackets = () => (
  <>
    {['left-2 top-2 border-l border-t rounded-tl-[14px]', 'right-2 top-2 border-r border-t rounded-tr-[14px]', 'left-2 bottom-2 border-l border-b rounded-bl-[14px]', 'right-2 bottom-2 border-r border-b rounded-br-[14px]'].map((c) => (
      <span key={c} className={`pointer-events-none absolute size-5 border-[#9eeaff]/45 ${c}`} />
    ))}
    <span className="pointer-events-none absolute inset-x-[18%] top-0 h-px bg-gradient-to-r from-transparent via-[#bff3ff]/80 to-transparent" />
  </>
);

// ------------------------------------------------------------------ header

function Head({ title, sub, status, chip, chipClass, stale }: { title: string; sub: string; status: SystemStatus; chip: string; chipClass: string; stale?: string | null }) {
  const hex = TONE_HEX[status.tone];
  return (
    <div className="flex min-w-0 items-center gap-3 whitespace-nowrap">
      <span className="display shrink-0 text-[11px] font-medium uppercase tracking-[0.32em] text-[#cfefff]">{title}</span>
      <span className="hidden h-3 w-px shrink-0 bg-white/15 sm:block" />
      <span className="hidden min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3 sm:block">{sub}</span>
      {stale && <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-warn">{stale}</span>}
      <span className="flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: hex, borderColor: `${hex}55`, background: `${hex}12` }}>
        <span className="relative flex size-1.5">
          {status.pulse && <span className="absolute inset-0 animate-ping rounded-full opacity-70" style={{ background: hex }} />}
          <span className="relative size-1.5 rounded-full" style={{ background: hex }} />
        </span>
        {status.label}
      </span>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] ${chipClass}`}><span className="md:hidden">{chip.split(' · ')[0]}</span><span className="hidden md:inline">{chip}</span></span>
    </div>
  );
}

// ------------------------------------------------------------------ twin

function useKpiHistory(): Kpi[] {
  const [hist, setHist] = useState<Kpi[]>([]);
  const buf = useRef<Kpi[]>([]);
  useEffect(() => {
    let lastT = -1, lastPush = 0;
    const off = store.onFrame((f) => {
      if (f.kpi.t === lastT) return;
      lastT = f.kpi.t;
      if (buf.current.length && f.kpi.t < buf.current[buf.current.length - 1].t) buf.current = [];
      buf.current.push(f.kpi);
      if (buf.current.length > 150) buf.current.shift();
      const now = performance.now();
      if (now - lastPush > 500) { lastPush = now; setHist([...buf.current]); }
    });
    return () => { off(); };
  }, []);
  return hist;
}

function useStale(): string | null {
  const connected = useStore((s) => s.connected);
  const seq = useStore((s) => s.frame?.t ?? 0);
  const paused = useStore((s) => s.frame?.paused ?? false);
  const [now, setNow] = useState(() => performance.now());
  const at = useRef({ seq: -1, t: performance.now() });
  if (seq !== at.current.seq) at.current = { seq, t: performance.now() };
  useEffect(() => { const i = setInterval(() => setNow(performance.now()), 1000); return () => clearInterval(i); }, []);
  if (!connected) return 'offline · last frame';
  const age = (now - at.current.t) / 1000;
  return !paused && age > 4 ? `stale · ${Math.round(age)} s` : null;
}

function TwinHolo({ compact, mini, incident }: { compact: boolean; mini: boolean; incident: { title: string; since: number; detected: boolean } | null }) {
  const frame = useStore((s) => s.frame);
  const topo = useStore((s) => s.topo);
  const connected = useStore((s) => s.connected);
  const run = useStore((s) => s.doctor);
  const mode = useStore((s) => s.mode);
  const autopilot = useStore((s) => s.autopilot);
  const hist = useKpiHistory();
  const stale = useStale();
  if (!frame || !topo) return <div className="grid flex-1 place-items-center font-mono text-[11px] text-ink-4">Connecting to the twin…</div>;
  const status = systemStatus(connected, frame, run);
  const replay = mode === 'replay';
  const k = frame.kpi;
  const slo = topo.slo;
  const doing = run && !run.terminal && !replay ? status.label : run?.terminal ? `last run ${run.terminal.replace('_', ' ').toLowerCase()} · ${run.states[run.states.length - 1]?.clock ?? ''}` : 'standing by';
  return (
    <>
      <Head
        title="War Room"
        sub={`AI datacenter · ${topo.title.split(':')[0]} · ${topo.workers.length} vLLM replicas`}
        status={status}
        chip={replay ? 'Replay · recorded here' : 'Simulated · SimPy twin'}
        chipClass={replay ? 'border-replay/35 text-replay' : 'border-info/30 text-info'}
        stale={stale}
      />
      <div className={`mt-2.5 grid min-h-0 flex-1 gap-5 ${mini ? 'grid-cols-1' : compact ? 'grid-cols-[150px_1fr]' : 'grid-cols-[176px_1fr_168px]'}`}>
        <div className={`min-h-0 justify-center gap-2.5 ${mini ? 'grid grid-cols-2 content-center gap-x-5' : 'flex flex-col'}`}>
          <Signal label="TTFT p95" value={ms(k.ttft_p95)} data={hist.map((x) => x.ttft_p95)} max={slo.ttft_p95_s * 2} bad={k.ttft_p95 != null && k.ttft_p95 > slo.ttft_p95_s} limit={0.5} />
          <Signal label="Errors" value={pct(k.error_rate, 2)} data={hist.map((x) => x.error_rate)} max={0.08} bad={k.error_rate > slo.error_rate} limit={slo.error_rate / 0.08} />
          <Signal label="Tool-call canary" value={pct(k.canary, 0)} data={hist.map((x) => x.canary)} max={1} bad={k.canary < 0.999} invert />
          <Signal label="Capacity" value={pct(k.capacity, 0)} data={hist.map((x) => x.capacity)} max={1} bad={k.capacity < 0.98} invert />
        </div>
        {!mini && <TwinTopology frame={frame} />}
        {!compact && (
          <dl className="flex flex-col justify-center gap-2 text-[11px]">
            <Row k="Doctors" v={doing} tone={run && !run.terminal && !replay ? 'text-[#9eeaff]' : 'text-ink-2'} />
            <Row k="Controller" v="rule-based stand-in" sub="Nemotron not connected" />
            <Row k="Autopilot" v={autopilot ? 'on · acts within policy' : 'off · asks first'} />
            <Row k="Throughput" v={`${k.rps_in.toFixed(0)} rps · ${(k.tps / 1000).toFixed(1)}k tok/s`} />
            <Row k="Facility" v={`PUE ${k.pue.toFixed(2)} · ${k.supply_c.toFixed(1)} °C supply`} tone={frame.hall.crahs.some((c) => !c.running) || Object.values(frame.hall.ups).some((u) => !u) ? 'text-bad' : 'text-ink-2'} />
          </dl>
        )}
      </div>
      {incident && !incident.detected && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[54px] flex justify-center">
          <span className="font-mono text-[10px] text-ink-3"><span className="text-bad">● </span>{incident.title} · injected {Math.max(0, Math.round(incident.since))} s ago · the doctors see only what monitoring sees</span>
        </div>
      )}
    </>
  );
}

function Row({ k, v, sub, tone = 'text-ink-2' }: { k: string; v: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-[#6f889b]">{k}</dt>
      <dd className={`truncate ${tone}`}>{v}{sub && <span className="block truncate text-[10px] text-ink-4">{sub}</span>}</dd>
    </div>
  );
}

function Signal({ label, value, data, max, bad, invert, limit }: { label: string; value: string; data: (number | null)[]; max: number; bad: boolean; invert?: boolean; limit?: number }) {
  const w = 100, h = 18;
  const pts = data.map((d, i) => `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h - Math.min(1, Math.max(0, (d ?? 0) / max)) * (h - 3) - 1.5).toFixed(1)}`);
  const col = bad ? (invert ? '#f5a524' : '#f43f5e') : '#7fd6ff';
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-[#7f98ab]">{label}</span>
        <span className="tnum font-mono text-[12px] transition-colors duration-500" style={{ color: bad ? col : '#e6f6ff' }}>{value}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-0.5 h-[18px] w-full overflow-visible" preserveAspectRatio="none">
        {limit != null && <line x1="0" x2={w} y1={h - limit * (h - 3) - 1.5} y2={h - limit * (h - 3) - 1.5} stroke="rgba(255,255,255,0.12)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
        <polyline points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={`${col}14`} stroke="none" />
        <polyline points={pts.join(' ')} fill="none" stroke={col} strokeWidth="1.2" vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 3px ${col}aa)` }} />
      </svg>
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off';
const T_HEX: Record<Tone, string> = { ok: '#76b900', warn: '#f5a524', bad: '#f43f5e', info: '#38bdf8', off: '#4a5862' };

export function replicaTone(w: WorkerFrame): Tone {
  if (w.state === 'crashed') return 'bad';
  if (w.state === 'hung' || !w.canary) return 'warn';
  if (w.state === 'restarting' || w.draining) return 'info';
  if (w.state === 'cordoned' || w.weight === 0) return 'off';
  return 'ok';
}

/** Users and agents → gateway → replicas, with the facility under them. Particles move with real traffic. */
function TwinTopology({ frame }: { frame: Frame }) {
  const reduce = !!useReducedMotion();
  const W = 520, H = 176;
  const gx = 168, gy = H / 2;
  const n = frame.workers.length;
  const rx = 352;
  const ry = (i: number) => 16 + (i * (H - 32)) / Math.max(1, n - 1);
  const hallBad = frame.hall.crahs.some((c) => !c.running) || Object.values(frame.hall.ups).some((u) => !u);
  const racksBad = frame.racks.filter((r) => r.net).length;
  const xid = frame.gpu.flag.some((f) => f === 3);
  const gwTone: Tone = frame.gateway.shed > 0 ? 'warn' : frame.gateway.throttle_rps != null ? 'info' : 'ok';
  const rps = frame.kpi.rps_in;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full min-h-0 w-full" preserveAspectRatio="xMidYMid meet" aria-label="Live topology">
      <defs>
        <radialGradient id="wr-node"><stop offset="0" stopColor="#9eeaff" stopOpacity="0.5" /><stop offset="1" stopColor="#9eeaff" stopOpacity="0" /></radialGradient>
      </defs>
      {/* demand */}
      {[{ y: gy - 34, label: 'users', icon: 'M-4 4v-1a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v1M0 -2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8' }, { y: gy + 34, label: 'AI agents', icon: 'M-4 -3h8v6h-8zM-1.5 0h.01M1.5 0h.01M0 -3v-2' }].map((d, i) => (
        <g key={d.label}>
          <path id={`wr-d${i}`} d={`M58 ${d.y} C 110 ${d.y}, 120 ${gy}, ${gx - 18} ${gy}`} fill="none" stroke="rgba(158,234,255,0.22)" strokeWidth="1" />
          {!reduce && rps > 0 && [0, 1].map((k) => <circle key={k} r="1.6" fill="#bff3ff" className="wr-flow" style={{ offsetPath: `path('M58 ${d.y} C 110 ${d.y}, 120 ${gy}, ${gx - 18} ${gy}')`, animationDuration: `${2.6}s`, animationDelay: `${k * 1.3 + i * 0.4}s` }} />)}
          <circle cx="40" cy={d.y} r="13" fill="rgba(10,22,34,0.6)" stroke="rgba(158,234,255,0.4)" />
          <path d={d.icon} transform={`translate(40 ${d.y})`} fill="none" stroke="#cfefff" strokeWidth="1.1" strokeLinecap="round" />
          <text x="40" y={d.y + 25} textAnchor="middle" className="wr-t">{d.label}</text>
        </g>
      ))}
      {/* gateway */}
      <circle cx={gx} cy={gy} r="34" fill="url(#wr-node)" opacity="0.35" />
      <polygon points={hex(gx, gy, 17)} fill="rgba(10,22,34,0.75)" stroke={T_HEX[gwTone]} strokeWidth="1.2" />
      <path d="M-6 0h4l3-4h5M-2 0l3 4h5" transform={`translate(${gx} ${gy})`} fill="none" stroke="#e6f6ff" strokeWidth="1.2" strokeLinecap="round" />
      <text x={gx} y={gy + 31} textAnchor="middle" className="wr-t">gateway · {rps.toFixed(0)} rps</text>
      {/* replicas */}
      {frame.workers.map((w, i) => {
        const tone = replicaTone(w);
        const y = ry(i);
        const d = `M${gx + 18} ${gy} C ${gx + 90} ${gy}, ${rx - 90} ${y}, ${rx - 10} ${y}`;
        const f = frame.flows[w.id];
        const flowing = !reduce && w.weight > 0 && (f?.disp ?? 0) + (f?.ok ?? 0) > 0;
        return (
          <g key={w.id}>
            <path d={d} fill="none" stroke={tone === 'ok' ? 'rgba(118,185,0,0.28)' : `${T_HEX[tone]}99`} strokeWidth={tone === 'ok' ? 0.9 : 1.2} strokeDasharray={tone === 'off' ? '2 3' : undefined} />
            {flowing && <circle r="1.7" fill={tone === 'warn' ? '#f5a524' : tone === 'bad' ? '#f43f5e' : '#c6f36b'} className="wr-flow" style={{ offsetPath: `path('${d}')`, animationDuration: `${1.8 + (i % 3) * 0.3}s`, animationDelay: `${(i * 0.37) % 1.6}s` }} />}
            {(tone === 'bad' || tone === 'warn') && !reduce && <circle cx={rx} cy={y} r="7" fill="none" stroke={T_HEX[tone]} className="wr-ping" />}
            <rect x={rx - 7} y={y - 5.5} width="14" height="11" rx="2.5" fill="rgba(10,22,34,0.85)" stroke={T_HEX[tone]} strokeWidth="1.1" />
            <circle cx={rx - 2.5} cy={y} r="1.3" fill={T_HEX[tone]} />
            <text x={rx + 13} y={y + 3} className="wr-t" fill={tone === 'ok' ? undefined : T_HEX[tone]}>{w.id}</text>
          </g>
        );
      })}
      {/* facility underneath */}
      <g transform={`translate(${rx + 74} 0)`}>
        <line x1="0" x2="0" y1="12" y2={H - 12} stroke="rgba(158,234,255,0.14)" />
        {[
          ...frame.hall.crahs.map((c) => ({ id: c.id, ok: c.running })),
          ...Object.entries(frame.hall.ups).map(([id, on]) => ({ id, ok: on })),
          { id: racksBad ? `${racksBad} ToR link${racksBad > 1 ? 's' : ''}` : 'ToR links', ok: !racksBad },
          { id: xid ? 'GPU XID' : 'GPUs', ok: !xid },
        ].map((u, i) => (
          <g key={u.id} transform={`translate(0 ${22 + i * 25})`}>
            <rect x="-4" y="-4" width="8" height="8" rx="1.5" fill={u.ok ? 'rgba(56,189,248,0.25)' : '#f43f5e'} stroke={u.ok ? 'rgba(158,234,255,0.5)' : '#f43f5e'} className={u.ok || reduce ? undefined : 'wr-blink'} />
            <text x="10" y="3" className="wr-t" fill={u.ok ? undefined : '#f43f5e'}>{u.id}</text>
          </g>
        ))}
        <text x="-4" y={H - 2} className="wr-t wr-dim">facility{hallBad ? ' · alarm' : ''}</text>
      </g>
    </svg>
  );
}

const hex = (x: number, y: number, r: number) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i + Math.PI / 6; return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`; }).join(' ');

// ------------------------------------------------------------------ real fleet

function FleetHolo({ compact, mini }: { compact: boolean; mini: boolean }) {
  const rec = useFleet((s) => s.detail)!;
  const cursor = useFleet((s) => s.cursor);
  const v = fleetView(rec, cursor);
  const flow = useMemo(() => fromFleet(rec, Math.floor(cursor / 250) * 250), [rec, Math.floor(cursor / 250)]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = fleetStatus(flow);
  const s = rec.summary;
  const worst = (k: 'p95' | 'err') => Math.max(0, ...Object.values(v.route).map((r) => r[k]));
  return (
    <>
      <Head
        title="War Room"
        sub={`Real fleet · ${s.environment ?? 'brev'} · ${s.started_at.slice(0, 10)} ${utc(s.started_at)} UTC`}
        status={status}
        chip="Replay · recorded"
        chipClass="border-replay/35 text-replay"
      />
      <div className={`mt-2.5 grid min-h-0 flex-1 gap-5 ${mini ? 'grid-cols-1' : compact ? 'grid-cols-[150px_1fr]' : 'grid-cols-[176px_1fr_168px]'}`}>
        <div className="flex flex-col justify-center gap-2.5">
          {['target-a', 'target-b'].map((id) => {
            const r = v.route[id];
            return (
              <div key={id}>
                <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-ink-4">{id} · route</div>
                <div className={`tnum font-mono text-[12px] ${r && !r.ok ? 'text-bad' : 'text-[#e6f6ff]'}`}>{r ? `p95 ${ms(r.p95)} · ${pct(r.err, 0)} err` : 'not probed yet'}</div>
              </div>
            );
          })}
          <div>
            <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-ink-4">Worst route</div>
            <div className="tnum font-mono text-[12px] text-ink-2">{Object.keys(v.route).length ? `p95 ${ms(worst('p95'))} · ${pct(worst('err'), 0)}` : '–'}</div>
          </div>
        </div>
        {!mini && <FleetTopology workers={v.workers} route={v.route} repair={v.repair} />}
        {!compact && (
          <dl className="flex flex-col justify-center gap-2 text-[11px]">
            <Row k="Controller" v={`NVIDIA ${modelName(s.controller)}`} tone="text-accent" />
            <Row k="Executor" v={v.repair ? `${v.repair.action} · ${Math.round(v.repair.progress * 100)}%` : 'idle'} tone={v.repair && v.repair.progress < 1 ? 'text-info' : 'text-ink-2'} />
            <Row k="Referee" v={v.referee ? (s.success ? 'scored a success' : 'scored a failure') : 'waits for the run to close'} tone={v.referee ? (s.success ? 'text-ok' : 'text-bad') : 'text-ink-3'} />
            <Row k="Outcome" v={flow.terminal ? fleetVerdict(s).label : '–'} tone={flow.verdict ? TONE_TEXT[flow.verdict.tone] : 'text-ink-3'} />
          </dl>
        )}
      </div>
    </>
  );
}

const W_HEX: Record<FleetWorker['state'], string> = { serving: '#76b900', faulty: '#f43f5e', repairing: '#38bdf8', repaired: '#76b900', drained: '#6e7b83', unresolved: '#f43f5e' };

function FleetTopology({ workers, route, repair }: { workers: FleetWorker[]; route: Record<string, { p95: number; err: number; ok: boolean }>; repair: { progress: number; target: string } | null }) {
  const reduce = !!useReducedMotion();
  const W = 520, H = 176, gx = 190, gy = H / 2;
  const pos: Record<string, number> = { 'target-a': 44, 'target-b': 132 };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full min-h-0 w-full" preserveAspectRatio="xMidYMid meet" aria-label="Recorded fleet topology">
      <path d={`M56 ${gy} L ${gx - 20} ${gy}`} stroke="rgba(158,234,255,0.24)" />
      <circle cx="40" cy={gy} r="15" fill="rgba(10,22,34,0.6)" stroke="rgba(158,234,255,0.4)" />
      <path d="M-4 4v-1a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v1M0 -2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8" transform={`translate(40 ${gy})`} fill="none" stroke="#cfefff" strokeWidth="1.1" strokeLinecap="round" />
      <text x="40" y={gy + 28} textAnchor="middle" className="wr-t">users</text>
      <polygon points={hex(gx, gy, 21)} fill="rgba(10,22,34,0.75)" stroke="#9eeaff" strokeWidth="1.2" />
      <path d="M-6 0h4l3-4h5M-2 0l3 4h5" transform={`translate(${gx} ${gy})`} fill="none" stroke="#e6f6ff" strokeWidth="1.2" strokeLinecap="round" />
      <text x={gx} y={gy + 35} textAnchor="middle" className="wr-t">HAProxy</text>
      {workers.map((w) => {
        const y = pos[w.id], col = W_HEX[w.state];
        const d = `M${gx + 22} ${gy} C ${gx + 90} ${gy}, ${320 - 90} ${y}, 312 ${y}`;
        const r = route[w.id];
        const drained = w.state === 'drained';
        return (
          <g key={w.id}>
            <path d={d} fill="none" stroke={drained ? 'rgba(110,123,131,0.4)' : `${col}88`} strokeWidth="1.1" strokeDasharray={drained ? '3 4' : r && !r.ok ? '5 4' : undefined} />
            {!reduce && !drained && <circle r="1.8" fill={col} className="wr-flow" style={{ offsetPath: `path('${d}')`, animationDuration: r && !r.ok ? '4.5s' : '1.9s' }} />}
            {(w.state === 'faulty' || w.state === 'unresolved') && !reduce && <circle cx="336" cy={y} r="20" fill="none" stroke="#f43f5e" className="wr-ping" />}
            <rect x="312" y={y - 16} width="48" height="32" rx="6" fill="rgba(10,22,34,0.85)" stroke={col} strokeWidth="1.3" />
            <path d="M-9 -6h18v5h-18zM-9 2h18v5h-18z" transform={`translate(336 ${y})`} fill="none" stroke={col} strokeWidth="1" opacity="0.85" />
            {repair && repair.target === w.id && repair.progress < 1 && (
              <circle cx="336" cy={y} r="25" fill="none" stroke="#38bdf8" strokeWidth="1.8" strokeDasharray={`${(repair.progress * 157).toFixed(1)} 157`} transform={`rotate(-90 336 ${y})`} />
            )}
            <text x="372" y={y - 4} className="wr-t" fill={col} style={{ fontSize: 10 }}>{w.id}</text>
            <text x="372" y={y + 8} className="wr-t wr-dim">{w.state}{w.parser ? ` · parser ${w.parser}` : ''}</text>
            {r && <text x="372" y={y + 19} className="wr-t wr-dim">p95 {ms(r.p95)} · {pct(r.err, 0)} err</text>}
          </g>
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------------ the control

function BreakControl({ onBreak, disabled, incident, replay }: { onBreak: (o: { x: number; y: number }) => void; disabled: string | null; incident: { title: string; detected: boolean } | null; replay: boolean }) {
  const busy = !!disabled && !!incident;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex translate-y-1/2 justify-center">
      {busy || replay ? (
        <span className="glass pointer-events-auto rounded-full px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-3">
          {replay ? <>Replay<span className="hidden sm:inline"> of a recorded run</span> · nothing here is live</> : 'Recovery in progress'}
        </span>
      ) : (
        <motion.button
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onBreak({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}
          disabled={!!disabled}
          title={disabled ?? 'Choose a failure to inject (B)'}
          whileHover={disabled ? undefined : { scale: 1.03 }}
          whileTap={disabled ? undefined : { scale: 0.97 }}
          className="break-trigger holo-break group pointer-events-auto flex h-[48px] items-center gap-3 overflow-hidden rounded-full pl-5 pr-6 text-[12px] font-semibold uppercase tracking-[0.26em] text-[#ffe4e9] disabled:opacity-45"
        >
          <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-1000 group-hover:translate-x-full" />
          <svg viewBox="0 0 24 24" className="relative size-[18px] fill-[#ff6b81] drop-shadow-[0_0_8px_rgba(244,63,94,1)]"><path d="M13.4 2 4.6 13.5h6.2L9.8 22l8.8-11.6h-6.1z" /></svg>
          <span className="relative whitespace-nowrap">Break the system</span>
        </motion.button>
      )}
    </div>
  );
}

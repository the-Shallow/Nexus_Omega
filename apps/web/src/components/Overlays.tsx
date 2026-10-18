import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { twin, useToasts } from '../lib/bus';
import { clock, ms, pct } from '../lib/format';
import { store, useStore } from '../lib/store';
import type { Entity, HoverEvent } from '../twin/scene';
import type { Frame, Kpi } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

// ------------------------------------------------------------------ vitals

interface Vital { key: string; label: string; value: (k: Kpi) => number | null; fmt: (v: number | null) => string; tone: (v: number | null) => string; max: number }

/** Four signals that matter, with a 3-minute trace. Bottom-left, out of the twin's way. */
export function Vitals() {
  const topo = useStore((s) => s.topo);
  const [hist, setHist] = useState<Kpi[]>([]);
  const buf = useRef<Kpi[]>([]);
  useEffect(() => {
    let lastT = -1, lastPush = 0;
    const off = store.onFrame((f) => {
      if (f.kpi.t === lastT) return;
      lastT = f.kpi.t;
      if (buf.current.length && f.kpi.t < buf.current[buf.current.length - 1].t) buf.current = [];
      buf.current.push(f.kpi);
      if (buf.current.length > 180) buf.current.shift();
      const now = performance.now();
      if (now - lastPush > 500) { lastPush = now; setHist([...buf.current]); }
    });
    return () => { off(); };
  }, []);
  if (!topo || !hist.length) return null;
  const slo = topo.slo;
  const vitals: Vital[] = [
    { key: 'ttft', label: 'TTFT p95', value: (k) => k.ttft_p95, fmt: ms, tone: (v) => (v != null && v > slo.ttft_p95_s ? 'text-bad' : 'text-ink'), max: slo.ttft_p95_s * 2 },
    { key: 'err', label: 'Errors', value: (k) => k.error_rate, fmt: (v) => pct(v ?? 0, 2), tone: (v) => ((v ?? 0) > slo.error_rate ? 'text-bad' : 'text-ink'), max: 0.1 },
    { key: 'canary', label: 'Tool-call canary', value: (k) => k.canary, fmt: (v) => pct(v ?? 0, 0), tone: (v) => ((v ?? 1) < 0.999 ? 'text-warn' : 'text-ink'), max: 1 },
    { key: 'gpu', label: 'Hottest GPU', value: (k) => k.max_gpu_c, fmt: (v) => `${(v ?? 0).toFixed(0)}°C`, tone: (v) => ((v ?? 0) > 87 ? 'text-bad' : (v ?? 0) > 80 ? 'text-warn' : 'text-ink'), max: 100 },
  ];
  const last = hist[hist.length - 1];
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.8, ease }}
      className="glass pointer-events-auto absolute bottom-5 left-6 z-10 hidden w-[248px] rounded-2xl p-3 2xl:block"
    >
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="label !text-[9.5px]">Vital signs</span>
        <span className="font-mono text-[10px] text-ink-4">{last.rps_in.toFixed(0)} rps</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {vitals.map((v) => {
          const val = v.value(last);
          return (
            <div key={v.key} className="rounded-xl bg-white/[0.025] px-2.5 py-2">
              <div className="text-[10.5px] text-ink-3">{v.label}</div>
              <div className={`tnum text-[15px] font-medium transition-colors duration-500 ${v.tone(val)}`}>{v.fmt(val)}</div>
              <Spark data={hist.map((k) => v.value(k))} max={v.max} />
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function Spark({ data, max }: { data: (number | null)[]; max: number }) {
  const w = 96, h = 18;
  const pts = data.map((d, i) => `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h - Math.min(1, (d ?? 0) / max) * (h - 2) - 1).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-[18px] w-full" preserveAspectRatio="none">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" className="text-ink-3" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ------------------------------------------------------------------ inspector

/** Hover card for anything in the twin: live values from the current frame. */
export function Inspector() {
  const [hover, setHover] = useState<HoverEvent | null>(null);
  const frame = useStore((s) => (hover?.entity ? s.frame : null));
  const topo = useStore((s) => s.topo);
  useEffect(() => twin.subscribe((scene) => scene?.on('hover', (e) => setHover(e.entity ? e : null))), []);
  return (
    <AnimatePresence>
      {hover?.entity && frame && topo && (
        <motion.div
          key={`${hover.entity.type}:${hover.entity.id}`}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.18 }}
          className="glass pointer-events-none absolute z-40 w-56 rounded-xl px-3 py-2.5 text-[12px]"
          style={{ left: Math.min(hover.x + 18, window.innerWidth - 240), top: Math.min(hover.y + 18, window.innerHeight - 200) }}
        >
          <EntityCard e={hover.entity} f={frame} topo={topo} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return <div className="flex justify-between gap-3"><span className="text-ink-3">{k}</span><span className={`tnum font-mono text-[11.5px] ${tone ?? 'text-ink'}`}>{v}</span></div>;
}

function EntityCard({ e, f, topo }: { e: Entity; f: Frame; topo: NonNullable<ReturnType<typeof store.get>['topo']> }) {
  const head = (type: string, id: string) => <div className="mb-1.5 flex items-baseline justify-between"><span className="font-medium text-ink">{id}</span><span className="label !text-[9px]">{type}</span></div>;
  if (e.type === 'worker') {
    const w = f.workers.find((x) => x.id === e.id);
    if (!w) return null;
    return (
      <>{head('vLLM replica', w.id)}
        <Row k="State" v={w.draining ? 'draining' : w.state} tone={w.state === 'crashed' ? 'text-bad' : w.state === 'hung' ? 'text-warn' : undefined} />
        <Row k="Tool-call canary" v={w.canary ? 'pass' : 'fail'} tone={w.canary ? 'text-ok' : 'text-warn'} />
        <Row k="TTFT p95" v={ms(w.ttft_p95)} />
        <Row k="Tokens / s" v={w.tps.toLocaleString()} />
        <Row k="KV cache" v={pct(w.kv, 0)} />
        <Row k="Parser" v={w.config.tool_parser} />
        <Row k="Template" v={w.config.chat_template} />
      </>
    );
  }
  if (e.type === 'node') {
    const nd = topo.nodes.find((n) => n.id === e.id);
    if (!nd) return null;
    const temps = nd.gpus.map((g) => f.gpu.temp[g]);
    const xid = nd.gpus.some((g) => f.gpu.flag[g] === 3);
    return (
      <>{head(`${nd.role} node`, nd.id)}
        <Row k="GPUs" v={`${nd.gpus.length} × ${topo.gpu.model.split(' ')[0]}`} />
        <Row k="Hottest GPU" v={`${Math.max(...temps).toFixed(0)}°C`} tone={Math.max(...temps) > 87 ? 'text-bad' : undefined} />
        <Row k="Power" v={`${(nd.gpus.reduce((a, g) => a + f.gpu.power[g], 0) / 1000).toFixed(1)} kW`} />
        <Row k="XID" v={xid ? 'fallen off the bus' : 'none'} tone={xid ? 'text-xid' : undefined} />
        <Row k="Cordoned" v={f.nodes[nd.id]?.[0] ? 'yes' : 'no'} />
      </>
    );
  }
  if (e.type === 'rack') {
    const r = f.racks.find((x) => x.id === e.id);
    if (!r) return null;
    return (
      <>{head('rack', r.id)}
        <Row k="Inlet" v={`${r.inlet.toFixed(1)}°C`} />
        <Row k="Exhaust" v={`${r.exhaust.toFixed(1)}°C`} tone={r.exhaust > 50 ? 'text-warn' : undefined} />
        <Row k="Power" v={`${r.power_kw.toFixed(1)} kW${r.capped ? ' · capped' : ''}`} tone={r.capped ? 'text-warn' : undefined} />
        <Row k="ToR link" v={r.net ? 'degraded' : 'healthy'} tone={r.net ? 'text-bad' : undefined} />
      </>
    );
  }
  if (e.type === 'crah') {
    const c = f.hall.crahs.find((x) => x.id === e.id);
    return (
      <>{head('cooling unit', e.id)}
        <Row k="State" v={c?.running ? 'running' : 'tripped'} tone={c?.running ? 'text-ok' : 'text-bad'} />
        <Row k="Supply air" v={`${f.hall.supply_c.toFixed(1)}°C`} />
        <Row k="Return air" v={`${f.hall.return_c.toFixed(1)}°C`} />
        <Row k="PUE" v={f.hall.pue.toFixed(2)} />
      </>
    );
  }
  if (e.type === 'ups') {
    const on = f.hall.ups[e.id];
    return (
      <>{head('power feed', e.id)}
        <Row k="State" v={on ? 'online' : 'feed lost'} tone={on ? 'text-ok' : 'text-bad'} />
        <Row k="IT load" v={`${f.hall.it_kw.toFixed(0)} kW total`} />
      </>
    );
  }
  return (
    <>{head('edge gateway', 'Gateway')}
      <Row k="Ingress" v={`${f.kpi.rps_in.toFixed(1)} rps`} />
      <Row k="Queue" v={`${f.kpi.queue + f.gateway.queue}`} />
      <Row k="Throttle" v={f.gateway.throttle_rps != null ? `${f.gateway.throttle_rps.toFixed(0)} rps` : 'off'} />
    </>
  );
}

// ------------------------------------------------------------------ replay

export function ReplayBar() {
  const replay = useStore((s) => s.replay);
  const t = useStore((s) => s.frame?.t ?? 0);
  return (
    <AnimatePresence>
      {replay && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-0 z-[5] shadow-[inset_0_0_0_2px_rgba(167,139,250,0.35),inset_0_0_120px_rgba(167,139,250,0.08)]" />
          <motion.div
            initial={{ y: -12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
            transition={{ duration: 0.45, ease }}
            className="glass pointer-events-auto absolute left-1/2 top-[88px] z-30 flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-2xl px-3 py-2"
          >
            <span className="rounded-md bg-replay/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-replay">Replay</span>
            <button onClick={() => store.setReplay({ playing: !replay.playing })} aria-label={replay.playing ? 'Pause replay' : 'Play replay'} className="grid size-7 place-items-center rounded-lg text-ink-2 hover:bg-white/5 hover:text-ink">
              {replay.playing ? <svg viewBox="0 0 24 24" className="size-3 fill-current"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg> : <svg viewBox="0 0 24 24" className="size-3 fill-current"><path d="M7 4.5v15l12.5-7.5z" /></svg>}
            </button>
            <input
              type="range" min={0} max={replay.recording.frames.length - 1} value={replay.index}
              onChange={(e) => store.setReplay({ index: Number(e.target.value), playing: false })}
              className="h-1 flex-1 cursor-pointer accent-[#a78bfa]" aria-label="Replay position"
            />
            <span className="tnum font-mono text-[11px] text-ink-2">{clock(t)}</span>
            <button onClick={() => store.exitReplay()} className="rounded-lg px-2.5 py-1 text-[12px] text-ink-2 hover:bg-white/5 hover:text-ink">Back to live</button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------------ toasts

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none absolute left-1/2 top-[88px] z-40 flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
            className={`glass rounded-xl px-3.5 py-2 text-[12.5px] ${t.tone === 'bad' ? 'text-[#ffd1d8]' : t.tone === 'ok' ? 'text-ok' : 'text-ink-2'}`}
          >
            {t.tone === 'bad' && <span className="mr-2 inline-block size-1.5 rounded-full bg-bad align-middle shadow-[0_0_8px_#f43f5e]" />}
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

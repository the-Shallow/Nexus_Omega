import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { twin, useToasts } from '../lib/bus';
import { ms } from '../lib/format';
import { useStore } from '../lib/store';
import type { Entity } from '../twin/scene';
import type { Frame, Topology } from '../lib/types';
import { OmegaMark, Wordmark } from './Logo';

const ease = [0.16, 1, 0.3, 1] as const;

// ------------------------------------------------------------------ capsule

type Health = { word: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted' };
interface CapsuleData { name: string; kind: string; health: Health; metrics: [string, string, string?][] }

function describe(e: Entity, f: Frame, topo: Topology): CapsuleData | null {
  if (e.type === 'worker') {
    const w = f.workers.find((x) => x.id === e.id);
    if (!w) return null;
    const health: Health = w.state === 'crashed' ? { word: 'Crashed', tone: 'bad' } : w.state === 'hung' ? { word: 'Hung · health still 200', tone: 'warn' }
      : w.draining ? { word: 'Draining', tone: 'info' } : w.state === 'restarting' ? { word: 'Restarting', tone: 'info' }
      : !w.canary ? { word: 'Silent failure · canary failing', tone: 'warn' } : { word: 'Healthy', tone: 'ok' };
    return { name: w.id, kind: 'vLLM replica', health, metrics: [['TTFT p95', ms(w.ttft_p95)], ['Tokens / s', w.tps.toLocaleString()], ['Tool-call canary', w.canary ? 'pass' : 'fail', w.canary ? 'text-ok' : 'text-warn']] };
  }
  if (e.type === 'node') {
    const nd = topo.nodes.find((n) => n.id === e.id);
    if (!nd) return null;
    const temps = nd.gpus.map((g) => f.gpu.temp[g]);
    const hot = Math.max(...temps);
    const xid = nd.gpus.some((g) => f.gpu.flag[g] === 3);
    const cordoned = !!f.nodes[nd.id]?.[0];
    const health: Health = xid ? { word: 'GPU fell off the bus (XID)', tone: 'bad' } : cordoned ? { word: 'Cordoned', tone: 'muted' } : hot > topo.gpu.slowdown_c ? { word: 'Thermal throttling', tone: 'warn' } : { word: 'Healthy', tone: 'ok' };
    return { name: nd.id, kind: `${nd.role} node`, health, metrics: [['GPUs', `${nd.gpus.length} × ${topo.gpu.model.split(' ')[0]}`], ['Hottest GPU', `${hot.toFixed(0)} °C`, hot > 87 ? 'text-bad' : undefined], ['Power', `${(nd.gpus.reduce((a, g) => a + f.gpu.power[g], 0) / 1000).toFixed(1)} kW`]] };
  }
  if (e.type === 'rack') {
    const r = f.racks.find((x) => x.id === e.id);
    if (!r) return null;
    const health: Health = r.net ? { word: 'Top-of-rack link degraded', tone: 'bad' } : r.capped ? { word: 'Power capped', tone: 'warn' } : r.exhaust > 50 ? { word: 'Running hot', tone: 'warn' } : { word: 'Healthy', tone: 'ok' };
    return { name: r.id, kind: 'rack', health, metrics: [['Inlet', `${r.inlet.toFixed(1)} °C`], ['Exhaust', `${r.exhaust.toFixed(1)} °C`, r.exhaust > 50 ? 'text-warn' : undefined], ['Power', `${r.power_kw.toFixed(1)} kW`]] };
  }
  if (e.type === 'crah') {
    const c = f.hall.crahs.find((x) => x.id === e.id);
    return { name: e.id, kind: 'cooling unit', health: c?.running ? { word: 'Running', tone: 'ok' } : { word: 'Tripped', tone: 'bad' }, metrics: [['Supply air', `${f.hall.supply_c.toFixed(1)} °C`], ['Return air', `${f.hall.return_c.toFixed(1)} °C`], ['PUE', f.hall.pue.toFixed(2)]] };
  }
  if (e.type === 'ups') {
    const on = f.hall.ups[e.id];
    const live = Object.values(f.hall.ups).filter(Boolean).length || 1;
    return { name: e.id, kind: 'power feed', health: on ? { word: 'Online', tone: 'ok' } : { word: 'Feed lost', tone: 'bad' }, metrics: [['Load', on ? `${(f.hall.it_kw / live).toFixed(0)} kW` : '0 kW'], ['IT load, hall', `${f.hall.it_kw.toFixed(0)} kW`]] };
  }
  const q = f.kpi.queue + f.gateway.queue;
  return {
    name: 'Gateway', kind: 'edge gateway',
    health: f.gateway.shed > 0 ? { word: 'Shedding load', tone: 'warn' } : f.gateway.throttle_rps != null ? { word: 'Throttling', tone: 'info' } : { word: 'Healthy', tone: 'ok' },
    metrics: [['Ingress', `${f.kpi.rps_in.toFixed(1)} rps`], ['Queue', String(q), q > 500 ? 'text-bad' : undefined], ['Limit', f.gateway.throttle_rps != null ? `${f.gateway.throttle_rps.toFixed(0)} rps` : 'off']],
  };
}

const HEALTH_DOT = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', muted: 'bg-ink-3' };
const HEALTH_TXT = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', muted: 'text-ink-3' };

/** Click anything in the twin: a small glass capsule anchored to it. */
export function Capsule({ disabled }: { disabled: boolean }) {
  const [sel, setSel] = useState<Entity | null>(null);
  const frame = useStore((s) => (sel ? s.frame : null));
  const topo = useStore((s) => s.topo);
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => twin.subscribe((scene) => { scene?.on('select', (e) => setSel(e)); }), []);
  useEffect(() => { if (disabled) setSel(null); }, [disabled]);
  useEffect(() => {
    if (!sel) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null); };
    window.addEventListener('keydown', esc);
    let raf = 0;
    const place = () => {
      const p = twin.get()?.screenPos(sel);
      if (el.current && p) {
        el.current.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, calc(-100% - 16px))`;
        el.current.style.opacity = p.visible ? '1' : '0';
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', esc); };
  }, [sel]);

  const data = sel && frame && topo ? describe(sel, frame, topo) : null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <AnimatePresence>
        {data && (
          <motion.div key={`${sel!.type}:${sel!.id}`} ref={el} className="absolute left-0 top-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
            <motion.div
              initial={{ y: 8, scale: 0.94, filter: 'blur(6px)' }}
              animate={{ y: 0, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.4, ease }}
              className="glass-strong pointer-events-auto relative w-[232px] rounded-[20px] px-3.5 pb-3 pt-2.5"
              role="dialog"
              aria-label={`${data.name} details`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[14px] font-medium text-ink">{data.name}</span>
                <span className="label !text-[8.5px]">{data.kind}</span>
              </div>
              <div className={`mt-1 flex items-center gap-1.5 text-[11.5px] ${HEALTH_TXT[data.health.tone]}`}>
                <span className={`size-1.5 rounded-full ${HEALTH_DOT[data.health.tone]}`} />{data.health.word}
              </div>
              <dl className="mt-2.5 space-y-1">
                {data.metrics.slice(0, 3).map(([k, v, tone]) => (
                  <div key={k} className="flex justify-between gap-3 text-[11.5px]"><dt className="text-ink-3">{k}</dt><dd className={`tnum font-mono text-[11px] ${tone ?? 'text-ink'}`}>{v}</dd></div>
                ))}
              </dl>
              <button onClick={() => setSel(null)} aria-label="Close details" className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full text-ink-4 opacity-0 transition hover:bg-white/5 hover:text-ink focus:opacity-100 [div:hover>&]:opacity-100">
                <svg viewBox="0 0 24 24" className="size-3 stroke-current" fill="none" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
              <span className="absolute -bottom-[5px] left-1/2 size-2.5 -translate-x-1/2 rotate-45 border-b border-r border-white/[0.07] bg-[#0b0f11]" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ toasts

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none absolute left-1/2 top-[86px] z-[45] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -8, scale: 0.96, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
            className={`glass rounded-full px-4 py-1.5 text-[12px] ${t.tone === 'bad' ? 'text-[#ffd1d8]' : t.tone === 'ok' ? 'text-ok' : 'text-ink-2'}`}
          >
            {t.tone === 'bad' && <span className="mr-2 inline-block size-1.5 rounded-full bg-bad align-middle shadow-[0_0_8px_#f43f5e]" />}
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ boot

/** First impression: the mark draws itself, then the hall fades up behind it. */
export function Boot() {
  const connected = useStore((s) => s.connected);
  const ready = useStore((s) => s.frame !== null && s.topo !== null);
  const [minDone, setMinDone] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const a = setTimeout(() => setMinDone(true), 1900);
    const b = setTimeout(() => setSlow(true), 3200);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  const show = !(ready && minDone);
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="absolute inset-0 z-[80] grid place-items-center bg-bg" initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 1.2, ease } }}>
          <motion.div className="flex flex-col items-center" exit={{ scale: 1.06, opacity: 0, filter: 'blur(6px)', transition: { duration: 0.9, ease } }}>
            <OmegaMark size={84} draw />
            <motion.div initial={{ opacity: 0, y: 8, letterSpacing: '0.5em' }} animate={{ opacity: 1, y: 0, letterSpacing: '0.28em' }} transition={{ duration: 1.4, delay: 0.5, ease }} className="mt-6">
              <Wordmark className="!text-[22px]" />
            </motion.div>
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1, duration: 0.8 }} className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.3em] text-ink-3">
              Autonomous AI operations
            </motion.p>
            <AnimatePresence>
              {slow && !connected && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-10 text-center">
                  <p className="text-[13px] text-ink-2">Connecting to the digital twin…</p>
                  <p className="mt-1 font-mono text-[11px] text-ink-4">./scripts/twin.sh serves it on :8765</p>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Lost the twin after the first load. */
export function Disconnected() {
  const connected = useStore((s) => s.connected);
  const loaded = useStore((s) => s.topo !== null);
  return (
    <AnimatePresence>
      {loaded && !connected && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="glass absolute bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-full px-4 py-2 text-[12px] text-warn">
          Twin connection lost · showing the last frame · reconnecting…
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** After the certificate: what to do next, without leaving the page. */
export function ContinueBar({ show, right, lifted, actions }: { show: boolean; right: number; lifted?: boolean; actions: { key: string; label: string; hint?: string; icon: ReactNode; onClick: () => void; disabled?: string | null; primary?: boolean }[] }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 20, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: 14, transition: { duration: 0.3 } }}
          transition={{ duration: 0.7, ease }}
          style={{ right, bottom: lifted ? 72 : 24 }}
          className="pointer-events-none absolute left-6 z-30 flex justify-center"
        >
          <div className="glass pointer-events-auto flex flex-wrap items-center justify-center gap-1 rounded-[22px] p-1.5">
            {actions.map((a) => (
              <button
                key={a.key}
                onClick={a.onClick}
                disabled={!!a.disabled}
                title={a.disabled ?? a.hint}
                className={`flex items-center gap-2.5 rounded-[16px] px-4 py-2 text-left text-[12.5px] transition disabled:cursor-not-allowed disabled:opacity-35 ${a.primary ? 'bg-[radial-gradient(120%_140%_at_50%_0%,rgba(244,63,94,0.3),rgba(60,8,18,0.5))] font-medium text-[#ffe1e6] shadow-[inset_0_0_0_1px_rgba(244,63,94,0.45)] hover:brightness-125' : 'text-ink-2 hover:bg-white/[0.06] hover:text-ink'}`}
              >
                {a.icon}
                <span className="flex flex-col leading-tight">
                  <span>{a.label}</span>
                  {a.hint && <span className={`font-mono text-[9px] tracking-[0.04em] ${a.primary ? 'text-[#ffb3c0]/70' : 'text-ink-4'}`}>{a.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

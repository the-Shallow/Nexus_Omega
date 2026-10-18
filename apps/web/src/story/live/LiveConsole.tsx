// The live column: proof that this is happening now on the real fleet. Clock, phase,
// what the dashboards say next to what the canary saw, real worker numbers, and the
// agent's own steps as they stream in. Every value comes from the box; blanks say so.
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { RunEvent } from '../../lib/types';
import { HERO } from './BreakLive';
import type { LiveFrame, LiveWorker } from './useLiveFleet';
import type { Canary, LiveRun, Phase } from './useLiveRun';

const ease = [0.16, 1, 0.3, 1] as const;

const STEPS: { phase: Phase[]; title: string; text: string }[] = [
  { phase: ['starting', 'breaking'], title: 'Breaking the fleet', text: 'Reset both workers, then inject the fault' },
  { phase: ['investigating'], title: 'Nemotron investigating', text: 'Typed, read-only tools on the live fleet' },
  { phase: ['repairing'], title: 'Executor repairing', text: 'Drain · apply the approved change · hidden canary' },
  { phase: ['verdict', 'done'], title: 'Referee', text: 'Independent checks decide if it worked' },
];

const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const num = (x: number | null | undefined, digits = 1, unit = '') => (x === null || x === undefined ? '–' : `${x.toFixed(digits)}${unit}`);

export function LiveConsole({ run, fleet, onFallback, onClose }: { run: LiveRun; fleet: LiveFrame | null; onFallback: () => void; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  const ticking = run.phase !== 'failed' && run.phase !== 'done';
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const title = HERO.find((h) => h.fault === run.fault)?.title ?? run.fault;
  const step = STEPS.findIndex((s) => s.phase.includes(run.phase));
  const tools = run.events.filter((e) => e.kind === 'tool_call').length;

  return (
    <motion.aside initial={{ x: 24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 24, opacity: 0 }} transition={{ duration: 0.6, ease }}
      className="glass-strong pointer-events-auto absolute bottom-6 right-4 top-[88px] z-20 flex w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl">
      <header className="border-b border-line px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2 font-mono text-[11.5px] font-semibold tracking-wider">
          {run.phase === 'failed'
            ? <span className="text-ink-3">● STOPPED</span>
            : <span className="flex items-center gap-1.5 text-bad"><span className="size-2 animate-pulse rounded-full bg-bad" />LIVE</span>}
          <span className="text-ink-3">· Brev H100</span>
          <span className="ml-auto text-[15px] tnum text-ink">{mmss((ticking ? now : Date.now()) - run.startedAt)}</span>
        </div>
        <h2 className="mt-1.5 text-[17px] font-semibold tracking-tight">{title}</h2>
        <div className="font-mono text-[11px] text-ink-4">{run.fault}{run.runIds.length ? ` · ${run.runIds.at(-1)}` : ''}</div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
        <ol className="space-y-2.5">
          {STEPS.map((s, i) => {
            const scored = run.phase === 'verdict' || run.phase === 'done';
            const state = run.phase === 'failed' ? (i < step ? 'done' : 'idle') : i < step || scored ? 'done' : i === step ? 'now' : 'idle';
            return (
              <li key={s.title} className="flex gap-3">
                <span className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full border-2 ${state === 'done' ? 'border-ok bg-ok' : state === 'now' ? 'animate-pulse border-accent' : 'border-line-2'}`} />
                <div className={state === 'idle' ? 'opacity-45' : ''}>
                  <div className="text-[13.5px] font-semibold leading-tight">
                    {s.title}{i === 1 && tools > 0 && <span className="ml-1.5 font-mono text-[11px] font-normal text-ink-3">{tools} tool call{tools === 1 ? '' : 's'}</span>}
                  </div>
                  <div className="text-[12px] text-ink-3">{s.text}</div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="grid grid-cols-2 gap-2">
          <Chip label="Dashboards" {...dashChip(fleet)} />
          <Chip label="Canary" {...canaryChip(run.canary, run.hidden)} />
        </div>

        <section>
          <div className="label mb-1.5">Real fleet · 1 s</div>
          {fleet ? (
            <div className="space-y-1.5">
              {fleet.workers.map((w) => <WorkerRow key={w.id} w={w} />)}
              <div className="flex justify-between rounded-lg bg-white/[0.03] px-2.5 py-1.5 font-mono text-[11.5px] text-ink-2 tnum">
                <span>H100</span>
                <span>{num(fleet.gpu.power[0], 0, ' W')} · {num(fleet.gpu.temp[0], 0, ' °C')} · {num(fleet.gpu.util[0] === null || fleet.gpu.util[0] === undefined ? null : fleet.gpu.util[0] * 100, 0, '%')}</span>
              </div>
            </div>
          ) : <div className="text-[12px] text-ink-4">Waiting for the live socket…</div>}
        </section>

        <section>
          <div className="label mb-1.5">Agent steps</div>
          <Stream events={run.events} />
        </section>
      </div>

      <footer className="border-t border-line px-4 py-3">
        {run.phase === 'failed' ? (
          <div className="space-y-2.5">
            <p className="text-[12.5px] leading-snug text-bad">{run.error}</p>
            <div className="flex gap-2 text-[13px] font-medium">
              <button onClick={onFallback} className="rounded-xl bg-accent px-3.5 py-2 font-semibold text-bg">Play a recorded run of this fault</button>
              <button onClick={onClose} className="rounded-xl bg-white/[0.07] px-3.5 py-2 hover:bg-white/[0.1]">Close</button>
            </div>
          </div>
        ) : run.phase === 'verdict' || run.phase === 'done' ? (
          <Verdict run={run} />
        ) : (
          <p className="text-[12px] text-ink-3">When the referee has scored it, the run replays here step by step.</p>
        )}
      </footer>
    </motion.aside>
  );
}

function Chip({ label, tone, text }: { label: string; tone: 'ok' | 'bad' | 'idle'; text: string }) {
  const c = tone === 'ok' ? 'border-ok/35 bg-ok/10 text-ok' : tone === 'bad' ? 'border-bad/40 bg-bad/10 text-bad' : 'border-line-2 bg-white/[0.03] text-ink-3';
  return (
    <div className={`rounded-xl border px-2.5 py-2 ${c}`}>
      <div className="label !text-current opacity-80">{label}</div>
      <div className="mt-0.5 text-[12.5px] font-semibold leading-snug">{text}</div>
    </div>
  );
}

/** What an operator's dashboard would say: the gateway's own error rate and latency against the SLO. */
function dashChip(f: LiveFrame | null): { tone: 'ok' | 'bad' | 'idle'; text: string } {
  const ok = f?.kpi.slo_ok;
  if (ok === null || ok === undefined) return { tone: 'idle', text: 'no data' };
  return ok ? { tone: 'ok', text: 'green · SLO met' } : { tone: 'bad', text: 'alarm · SLO missed' };
}

/** What the agent's tool-call canary actually got back, then the referee's hidden canary. */
function canaryChip(canary: Record<string, Canary>, hidden: boolean | null): { tone: 'ok' | 'bad' | 'idle'; text: string } {
  if (hidden !== null) return hidden ? { tone: 'ok', text: 'hidden canary passed' } : { tone: 'bad', text: 'hidden canary failed' };
  const seen = Object.entries(canary);
  if (!seen.length) return { tone: 'idle', text: 'not checked yet' };
  const bad = seen.find(([, c]) => !c.count);
  if (!bad) return { tone: 'ok', text: 'tool calls come back' };
  const [w, c] = bad;
  const why = c.status === 200 ? '200 OK, 0 tool calls' : !c.status ? 'no response' : `HTTP ${c.status}`;
  return { tone: 'bad', text: `${w.replace('target-', '')}: ${why}` };
}

function WorkerRow({ w }: { w: LiveWorker }) {
  const [label, c] = w.state === 'crashed' ? ['down', 'text-bad'] : w.draining ? ['drained', 'text-warn'] : w.state === 'ready' ? ['serving', 'text-ok'] : ['unknown', 'text-ink-3'];
  return (
    <div className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 font-mono text-[11.5px] tnum">
      <span className="w-[62px] text-ink">{w.id}</span>
      <span className={`w-[58px] ${c}`}>{label}</span>
      <span className="ml-auto text-ink-2">{num(w.rps, 1, ' rps')} · {w.error_rate === null ? '–' : `${(w.error_rate * 100).toFixed(0)}%`} err · p95 {num(w.ttft_p95, 2, 's')}</span>
    </div>
  );
}

function Stream({ events }: { events: RunEvent[] }) {
  const shown = events.filter((e) => e.kind !== 'state' && e.kind !== 'note').slice(-6);
  if (!shown.length) return <div className="text-[12px] text-ink-4">Nothing yet. The agent starts once the fault is in.</div>;
  return (
    <ol className="space-y-1">
      {shown.map((e, i) => (
        <motion.li key={`${e.seq}-${e.kind}-${i}`} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3 }}
          className="flex gap-2 text-[12px] leading-snug">
          <span className="w-[54px] shrink-0 font-mono text-[11px] text-ink-4 tnum">{e.clock}</span>
          <span className="w-[62px] shrink-0 font-mono text-[11px] text-ink-3">{e.kind.replace('_', ' ')}</span>
          <span className="min-w-0 truncate text-ink-2" title={e.title}>{e.title}</span>
        </motion.li>
      ))}
    </ol>
  );
}

function Verdict({ run }: { run: LiveRun }) {
  const fv = run.falseVerified;
  const tone = fv ? 'text-bad' : run.success ? 'text-ok' : run.success === false ? 'text-warn' : 'text-ink-2';
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className={`font-mono text-[13px] font-semibold ${tone}`}>{fv ? 'FALSE VERIFIED' : run.terminal ?? 'scored'}</div>
        <div className="text-[12px] text-ink-3">{run.success === null ? 'Referee scored the run' : run.success ? 'Referee: success' : 'Referee: not a success'}</div>
      </div>
      <span className="text-[12px] text-ink-3">{run.phase === 'done' ? 'Instant replay…' : 'Closing the run…'}</span>
    </div>
  );
}

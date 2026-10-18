import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../lib/api';
import { toast } from '../lib/bus';
import { pct } from '../lib/format';
import type { FlowItem, FlowRun, FlowStage, StageKey, StageStatus, Tone } from '../lib/flow';
import { useStore } from '../lib/store';
import type { Candidate } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

const STATUS_HEX: Record<StageStatus, string> = { active: '#76b900', done: '#76b900', waiting: '#f5a524', failed: '#f43f5e', halted: '#f5a524' };
const TONE_TXT: Record<Tone, string> = { ok: 'text-ok', bad: 'text-bad', warn: 'text-warn', muted: 'text-ink-3', info: 'text-info' };
const OUT_HEX: Record<Tone, string> = { ok: '#76b900', bad: '#f43f5e', warn: '#f5a524', muted: '#8a969d', info: '#38bdf8' };

/**
 * The recovery architecture, grown one module at a time as the run's real events
 * arrive. A module exists only once its stage has begun; a connector grows from the
 * previous module first, then the module materializes.
 */
export function Workflow({ flow, top, onCertificate, onDismiss }: { flow: FlowRun | null; top: number; onCertificate: () => void; onDismiss: () => void }) {
  return (
    <AnimatePresence>
      {flow && (
        <motion.aside
          key={flow.key}
          initial={{ opacity: 0, x: 40, filter: 'blur(8px)' }}
          animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, x: 40, filter: 'blur(6px)', transition: { duration: 0.45, ease } }}
          transition={{ duration: 0.9, ease, delay: 0.25 }}
          style={{ top }}
          className="pointer-events-none absolute bottom-4 right-4 z-20 flex w-[min(420px,calc(100vw-24px))] flex-col"
          aria-label="Recovery workflow"
        >
          <Header flow={flow} onDismiss={onDismiss} />
          <Stages flow={flow} onCertificate={onCertificate} />
          <Footer flow={flow} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Header({ flow, onDismiss }: { flow: FlowRun; onDismiss: () => void }) {
  const live = !flow.terminal;
  return (
    <div className="glass pointer-events-auto rounded-[22px] px-4 pb-3.5 pt-3">
      <div className="flex items-center gap-2.5">
        <span className="relative flex size-2">
          {live && <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-70" />}
          <span className={`relative size-2 rounded-full ${live ? 'bg-accent' : 'bg-ink-3'}`} style={!live && flow.verdict ? { background: OUT_HEX[flow.verdict.tone] } : undefined} />
        </span>
        <span className="label !text-[9.5px]">Recovery · {flow.doctor === 'tool' ? 'Tool-Calling Doctor' : 'Infrastructure Doctor'}</span>
        <button onClick={onDismiss} disabled={live} title={live ? 'The run is still in progress' : 'Hide the workflow'} aria-label="Hide the workflow" className="ml-auto grid size-7 place-items-center rounded-full text-ink-3 transition hover:bg-white/5 hover:text-ink disabled:opacity-0">
          <svg viewBox="0 0 24 24" className="size-3.5 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <h3 className="mt-1.5 truncate text-[16px] font-medium leading-snug text-ink">
        {flow.title}{flow.target && <span className="font-normal text-ink-3"> · {flow.target}</span>}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em]">
        {flow.controllerReal ? (
          <span className="rounded-full border border-accent/35 bg-accent/[0.07] px-2 py-0.5 text-accent" title="The controller that chose every tool call in this recording">NVIDIA {flow.controller}</span>
        ) : (
          <span className="rounded-full border border-line-2 px-2 py-0.5 text-ink-3" title={flow.controller}>Rule-based stand-in · Nemotron not connected</span>
        )}
        <span className={`rounded-full border px-2 py-0.5 ${flow.source === 'fleet' ? 'border-replay/35 text-replay' : 'border-info/30 text-info'}`}>
          {flow.source === 'fleet' ? 'real fleet · recorded' : 'simulated twin'}
        </span>
      </div>
    </div>
  );
}

function Stages({ flow, onCertificate }: { flow: FlowRun; onCertificate: () => void }) {
  const [open, setOpen] = useState<StageKey | null>(null);
  const focus = flow.stages[flow.stages.length - 1]?.key;
  useEffect(() => { setOpen(null); }, [flow.key]);
  return (
    <ol className="pointer-events-auto relative mt-1 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2 pr-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]">
      {flow.stages.map((s, i) => (
        <StageModule
          key={s.key}
          stage={s}
          index={i}
          prev={flow.stages[i - 1]}
          focus={s.key === focus}
          open={open === s.key}
          onToggle={() => setOpen((o) => (o === s.key ? null : s.key))}
          flow={flow}
          onCertificate={onCertificate}
        />
      ))}
    </ol>
  );
}

function StageModule({ stage, index, prev, focus, open, onToggle, flow, onCertificate }: {
  stage: FlowStage; index: number; prev?: FlowStage; focus: boolean; open: boolean; onToggle: () => void; flow: FlowRun; onCertificate: () => void;
}) {
  const live = stage.status === 'active' || stage.status === 'waiting';
  const hex = stage.key === 'certificate' && flow.verdict ? OUT_HEX[flow.verdict.tone] : STATUS_HEX[stage.status];
  const isCert = stage.key === 'certificate';
  return (
    <motion.li layout="position" transition={{ layout: { duration: 0.45, ease } }} className="relative">
      {index > 0 && <Connector color={prev?.status === 'failed' ? '#f43f5e' : hex} live={live} />}
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.96, rotateX: 18, filter: 'blur(6px)' }}
        animate={{ opacity: focus || open ? 1 : 0.78, y: 0, scale: 1, rotateX: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.7, delay: index > 0 ? 0.42 : 0.1, ease }}
        style={{ transformPerspective: 900 }}
        className={`glass relative overflow-hidden rounded-[20px] transition-[box-shadow] duration-700 ${index === 0 ? 'mt-2' : ''}`}
      >
        {live && <motion.span className="pointer-events-none absolute inset-0 rounded-[20px]" style={{ boxShadow: `inset 0 0 0 1px ${hex}55, 0 0 40px -12px ${hex}` }} animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }} />}
        {isCert && flow.terminal && <span className="pointer-events-none absolute inset-0 rounded-[20px]" style={{ boxShadow: `inset 0 0 0 1px ${hex}66, 0 0 46px -14px ${hex}` }} />}
        <button onClick={onToggle} aria-expanded={open} disabled={isCert} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
          <Node stage={stage} hex={hex} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium text-ink">{stage.label}</span>
              {stage.key === 'shadow' && <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-info/80">predicted · simulated</span>}
              <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-4">{stage.at}</span>
            </span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={stage.headline}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.25 }}
                className={`mt-0.5 block truncate font-mono text-[11px] ${isCert ? 'text-ink-2' : 'text-ink-3'}`}
              >
                {isCert && flow.verdict ? <span style={{ color: hex }}>{flow.verdict.label}</span> : null}
                {isCert && flow.verdict ? ' · ' : ''}{stage.headline || (live ? 'starting…' : '')}
              </motion.span>
            </AnimatePresence>
          </span>
          {!isCert && (
            <motion.svg animate={{ rotate: open ? 180 : 0 }} viewBox="0 0 24 24" className="size-3.5 shrink-0 stroke-ink-4" fill="none" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></motion.svg>
          )}
        </button>

        {flow.approval && stage.status === 'waiting' && <Approval flow={flow} />}
        {isCert && flow.terminal && <CertificateActions flow={flow} hex={hex} onCertificate={onCertificate} />}

        <AnimatePresence initial={false}>
          {open && !isCert && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.4, ease }} className="overflow-hidden">
              <div className="max-h-[38vh] overflow-y-auto border-t border-line px-3 pb-3 pt-2.5">
                {stage.candidates?.length ? <Candidates list={stage.candidates} chosen={stage.chosen ?? null} /> : null}
                <ul className="space-y-1">
                  {stage.items.map((it) => <Item key={it.id} it={it} />)}
                </ul>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.li>
  );
}

function Connector({ color, live }: { color: string; live: boolean }) {
  return (
    <div className="relative ml-[29px] h-5 w-px" style={{ ['--len' as string]: '20px' }}>
      <motion.div className="absolute inset-0 origin-top" style={{ background: `linear-gradient(${color}, ${color}88)` }} initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ duration: 0.42, ease: [0.65, 0, 0.35, 1] }} />
      {live && <span className="signal absolute -left-[2px] top-0 size-[5px] rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />}
    </div>
  );
}

function Node({ stage, hex }: { stage: FlowStage; hex: string }) {
  const live = stage.status === 'active' || stage.status === 'waiting';
  return (
    <span className="relative grid size-[34px] shrink-0 place-items-center">
      {live && <span className="absolute inset-0 rounded-full" style={{ border: `1px solid ${hex}`, animation: 'ring-out 2.2s cubic-bezier(.2,.6,.3,1) infinite' }} />}
      <span className="absolute inset-0 rounded-full" style={{ background: `radial-gradient(circle at 50% 35%, ${hex}${live ? '40' : '22'}, transparent 72%)`, boxShadow: `inset 0 0 0 1px ${hex}${live ? '99' : '44'}` }} />
      <span className="relative" style={{ color: stage.status === 'done' && stage.key !== 'certificate' ? `${hex}cc` : hex }}>
        {stage.status === 'failed' ? <Glyph.fail /> : stage.status === 'halted' && stage.key !== 'certificate' ? <Glyph.halt /> : GLYPH[stage.key]}
      </span>
    </span>
  );
}

export function Item({ it }: { it: FlowItem }) {
  const [open, setOpen] = useState(false);
  const can = it.payload !== undefined && it.payload !== null;
  const json = can ? JSON.stringify(it.payload, null, 2) : '';
  return (
    <li className="rounded-xl transition-colors hover:bg-white/[0.025]">
      <button onClick={() => can && setOpen((o) => !o)} className={`w-full px-2 py-1.5 text-left ${can ? '' : 'cursor-default'}`}>
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-[9.5px] text-ink-4">{it.at}</span>
          <span className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${it.tone === 'bad' ? 'bg-bad' : it.tone === 'warn' ? 'bg-warn' : it.tone === 'ok' ? 'bg-ok' : it.tone === 'info' ? 'bg-info' : 'bg-ink-4'}`} />
          <span className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${it.kind === 'tool' ? 'font-mono text-[11.5px] text-ink' : 'text-[12px] text-ink-2'}`}>
            {it.title}
            {it.kind === 'tool' && <span className="text-ink-3">({it.detail})</span>}
          </span>
          {can && <span className="shrink-0 font-mono text-[9px] text-ink-4">{open ? '−' : '+'}</span>}
        </div>
        {it.kind !== 'tool' && it.detail && <div className={`mt-0.5 pl-[58px] font-mono text-[10.5px] [overflow-wrap:anywhere] ${it.tone ? TONE_TXT[it.tone] : 'text-ink-3'} opacity-90`}>{it.detail}</div>}
        {it.result && <div className="mt-0.5 pl-[58px] font-mono text-[10.5px] text-ink-2 [overflow-wrap:anywhere]"><span className="text-ok">→</span> {it.result}</div>}
        {it.reason && <div className="mt-0.5 pl-[58px] text-[11px] italic text-ink-3">“{it.reason}”</div>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.pre initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mx-2 mb-1.5 overflow-hidden rounded-lg bg-black/35 font-mono text-[10px] leading-relaxed text-ink-2">
            <div className="max-h-52 overflow-auto px-2.5 py-2">{json.length > 3200 ? `${json.slice(0, 3200)}\n…` : json}</div>
          </motion.pre>
        )}
      </AnimatePresence>
    </li>
  );
}

export function Candidates({ list, chosen }: { list: Candidate[]; chosen: string | null }) {
  return (
    <div className="mb-2.5 rounded-xl border border-info/15 bg-info/[0.03] p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="label !text-[9px] !text-info/80">Shadow twin · predicted</span>
        <span className="font-mono text-[9px] text-ink-4">share of horizon inside SLO</span>
      </div>
      <ul className="space-y-1.5">
        {list.map((c, i) => {
          const frac = c.slo_fraction ?? 0;
          const rejected = c.policy === 'rejected';
          const isChosen = c.id === chosen;
          return (
            <li key={c.id} title={c.policy_reason || undefined}>
              <div className="flex items-center gap-2 text-[11.5px]">
                <span className={`min-w-0 flex-1 truncate ${isChosen ? 'text-ink' : rejected ? 'text-ink-4 line-through' : 'text-ink-2'}`}>{c.label}</span>
                {isChosen && <span className="rounded-full bg-accent/15 px-1.5 font-mono text-[9px] uppercase text-accent">chosen</span>}
                {rejected && <span className="rounded-full bg-bad/10 px-1.5 font-mono text-[9px] uppercase text-bad">policy</span>}
                <span className="tnum w-9 text-right font-mono text-[10.5px] text-ink-3">{pct(frac, 0)}</span>
              </div>
              <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/5">
                <motion.div className={`h-full rounded-full ${isChosen ? 'bg-accent' : rejected ? 'bg-bad/40' : 'bg-white/20'}`} initial={{ width: 0 }} animate={{ width: `${frac * 100}%` }} transition={{ duration: 0.9, delay: 0.1 + i * 0.06, ease }} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Approval({ flow }: { flow: FlowRun }) {
  const replay = useStore((s) => s.mode === 'replay');
  const a = flow.approval!;
  const send = (choice: string) => api.approve(a.runId, choice)
    .then(() => toast(choice === 'reject' ? 'Repair declined' : 'Repair authorized', choice === 'reject' ? 'info' : 'ok'))
    .catch((e) => toast(e.message, 'bad'));
  return (
    <div className="mx-3 mb-3 rounded-2xl border border-warn/30 bg-warn/[0.06] p-3">
      <p className="text-[12.5px] text-ink">Authorize <span className="font-medium">{a.label}</span>?</p>
      {a.candidate && (
        <p className="mt-1 text-[11px] text-ink-3">
          Predicted by the shadow twin: {pct(a.candidate.slo_fraction ?? 0, 0)} of the horizon inside SLO{a.candidate.recovered_s != null ? `, full capacity in ${Math.round(a.candidate.recovered_s)} s` : ''}.
        </p>
      )}
      <div className="mt-2.5 flex gap-2">
        <button disabled={replay} onClick={() => send('recommended')} className="rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-black transition hover:bg-accent-hi disabled:opacity-40">Authorize</button>
        <button disabled={replay} onClick={() => send('reject')} className="rounded-full border border-line-2 px-3.5 py-1.5 text-[12px] text-ink-2 transition hover:bg-white/5 disabled:opacity-40">Decline</button>
      </div>
      {replay && <p className="mt-2 text-[10.5px] text-ink-4">Replay: decisions cannot be changed.</p>}
    </div>
  );
}

function CertificateActions({ flow, hex, onCertificate }: { flow: FlowRun; hex: string; onCertificate: () => void }) {
  const faults = useStore((s) => s.frame?.faults);
  const replay = useStore((s) => s.mode === 'replay');
  const open = flow.source === 'twin' && !replay ? (faults ?? []).filter((f) => f.resolved_at == null) : [];
  const field = open.length > 0 && flow.terminal !== 'VERIFIED';
  const repair = () => Promise.all(open.map((f) => api.repair(f.id)))
    .then(() => toast(`Field repair recorded: ${open.map((f) => f.title).join(', ')}`, 'ok'))
    .catch((e) => toast(e.message, 'bad'));
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9, duration: 0.6, ease }} className="px-3 pb-3">
      {flow.reason && flow.reason !== flow.stages[flow.stages.length - 1]?.headline && <p className="mb-2.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink-3">{flow.reason}</p>}
      <button
        onClick={onCertificate}
        disabled={!flow.certificate}
        className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-full py-2.5 text-[12.5px] font-semibold transition disabled:opacity-40"
        style={{ background: `linear-gradient(180deg, ${hex}30, ${hex}14)`, boxShadow: `inset 0 0 0 1px ${hex}66, 0 0 30px -10px ${hex}`, color: hex === '#8a969d' ? '#d6dde1' : hex }}
      >
        <span className="pointer-events-none absolute inset-0 bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.14)_50%,transparent_70%)] bg-[length:200%_100%] animate-[shimmer_3.5s_linear_infinite]" />
        <Glyph.seal />
        <span className="relative">View Recovery Certificate</span>
      </button>
      {field && (
        <div className="mt-2.5 rounded-2xl border border-line-2 bg-white/[0.02] p-2.5">
          <p className="text-[11.5px] text-ink-2">Still open: {open.map((f) => f.title).join(', ')}. Software does not fix cooling, power or hardware.</p>
          <button onClick={repair} className="mt-2 rounded-full border border-line-2 px-3 py-1 text-[11.5px] text-ink transition hover:bg-white/5">Record the technician's field repair</button>
        </div>
      )}
    </motion.div>
  );
}

function Footer({ flow }: { flow: FlowRun }) {
  return (
    <div className="pointer-events-auto mt-1 flex items-center px-2 pt-1 font-mono text-[10px] text-ink-4">
      <span>{flow.counts.tools} tool calls · {flow.counts.evidence} evidence{flow.startedAt ? ` · since ${flow.startedAt}` : ''}</span>
    </div>
  );
}

// ------------------------------------------------------------------ glyphs

const S = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" className="size-[15px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const Glyph = {
  detect: () => <S><circle cx="12" cy="12" r="1.6" fill="currentColor" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" /></S>,
  diagnose: () => <S><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5M10.5 8v5M8 10.5h5" /></S>,
  tools: () => <S><path d="M8 5 4 12l4 7M16 5l4 7-4 7" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /></S>,
  shadow: () => <S><path d="M4 8.5 10 5l6 3.5v7L10 19l-6-3.5z" /><path d="m14 7.2 6 3.3v7L14 21" strokeDasharray="2 2.2" /></S>,
  act: () => <S><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></S>,
  verify: () => <S><path d="M12 3 5 6v5.5c0 4.2 3 7.7 7 9.5 4-1.8 7-5.3 7-9.5V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></S>,
  certificate: () => <S><circle cx="12" cy="9.5" r="5.5" /><path d="m9 14.3-1.5 6.2L12 18l4.5 2.5-1.5-6.2" /><path d="m10 9.6 1.4 1.4 2.8-2.8" /></S>,
  fail: () => <S><path d="M7 7l10 10M17 7 7 17" /></S>,
  halt: () => <S><path d="M9 7v10M15 7v10" /></S>,
  seal: () => <svg viewBox="0 0 24 24" className="relative size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="9.5" r="5.5" /><path d="m9 14.3-1.5 6.2L12 18l4.5 2.5-1.5-6.2" /></svg>,
};
const GLYPH: Record<StageKey, ReactNode> = {
  detect: <Glyph.detect />, diagnose: <Glyph.diagnose />, tools: <Glyph.tools />, shadow: <Glyph.shadow />, act: <Glyph.act />, verify: <Glyph.verify />, certificate: <Glyph.certificate />,
};

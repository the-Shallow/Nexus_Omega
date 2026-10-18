import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArchScene } from '../arch/scene';
import { api } from '../lib/api';
import { NEXUS, type ArchId, type ArchModel, type ArchNode } from '../lib/arch';
import { arch, toast } from '../lib/bus';
import { LABEL, type FlowRun, type StageKey, type Tone } from '../lib/flow';
import { useStore } from '../lib/store';
import { Approval, Candidates, Item } from './Workflow';

const ease = [0.16, 1, 0.3, 1] as const;
const HEX: Record<Tone, string> = { ok: '#76b900', bad: '#f43f5e', warn: '#f5a524', muted: '#9aa6ad', info: '#38bdf8' };
const STAGES: StageKey[] = ['detect', 'diagnose', 'tools', 'shadow', 'act', 'verify', 'certificate'];
const STATE_TEXT: Record<ArchNode['state'], string> = {
  active: 'running', done: 'done', failed: 'failed', waiting: 'waiting', fault: 'failure here', context: 'in the system', ghost: 'not used by this run',
};
const STATE_CLS: Record<ArchNode['state'], string> = {
  active: 'text-[#9eeaff]', done: 'text-ok', failed: 'text-bad', waiting: 'text-warn', fault: 'text-bad', context: 'text-ink-3', ghost: 'text-ink-4',
};

export interface ArchHead { title: string; target: string | null; controller: string; controllerReal: boolean; source: 'twin' | 'fleet' }

/**
 * The right side of the War Room during an incident: the recovery architecture,
 * assembling itself in 3D as the run's events arrive.
 */
export function ArchPanel({ show, episodeKey, model, flow, head, width, top, onCertificate, onDismiss }: {
  show: boolean; episodeKey: string | null; model: ArchModel | null; flow: FlowRun | null; head: ArchHead | null;
  width: number; top: number; onCertificate: () => void; onDismiss: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<ArchScene | null>(null);
  const [sel, setSel] = useState<ArchId | null>(null);

  useEffect(() => {
    if (!show || !host.current) return;
    const s = new ArchScene(host.current);
    arch.set(s, host.current);
    setScene(s);
    const off = s.onSelect((id) => setSel((cur) => (id && cur !== id ? id : null)));
    return () => { off(); arch.set(null, null); s.dispose(); setScene(null); };
  }, [show]);

  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!scene) return;
    if (episodeKey !== lastKey.current) { scene.clear(); lastKey.current = episodeKey; setSel(null); }
    if (model) scene.setModel(model);
  }, [scene, model, episodeKey]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const node = sel ? model?.nodes.find((n) => n.id === sel) ?? null : null;
  const terminal = !!flow?.terminal;
  const verdictHex = flow?.verdict ? HEX[flow.verdict.tone] : HEX.muted;

  return (
    <AnimatePresence>
      {show && (
        <motion.aside
          key="arch"
          initial={{ opacity: 0, x: 50, filter: 'blur(10px)' }}
          animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, x: 40, filter: 'blur(8px)', transition: { duration: 0.5, ease } }}
          transition={{ duration: 1.1, ease, delay: 0.15 }}
          style={{ width, top }}
          className="absolute bottom-3 right-3 z-20 flex flex-col"
          aria-label="Recovery architecture"
        >
          {/* A faint holographic plate behind the board. */}
          <div className="pointer-events-none absolute inset-0 -z-10 rounded-[34px] bg-[radial-gradient(90%_70%_at_50%_45%,rgba(56,189,248,0.07),transparent_70%)]" />
          <div className="pointer-events-none absolute inset-y-6 left-0 -z-10 w-px bg-gradient-to-b from-transparent via-[#9eeaff]/20 to-transparent" />
          {head && <Header head={head} flow={flow} model={model} terminal={terminal} onDismiss={onDismiss} />}
          <div className="relative min-h-0 flex-1">
            <div ref={host} className="absolute inset-0" />
            {scene && flow?.approval && <Anchor scene={scene} id="policy" side="right"><div className="glass w-[280px] rounded-2xl pt-3"><Approval flow={flow} /></div></Anchor>}
            {scene && terminal && flow?.certificate && (
              <Anchor scene={scene} id="certificate" side="below">
                <CertButton hex={verdictHex} label={flow.verdict?.label ?? flow.terminal ?? ''} onClick={onCertificate} />
              </Anchor>
            )}
            {scene && terminal && flow?.source === 'twin' && <FieldRepair scene={scene} flow={flow} />}
            <AnimatePresence>
              {scene && node && <Popover key={node.id} scene={scene} node={node} flow={flow} onClose={() => setSel(null)} />}
            </AnimatePresence>
          </div>
          <Footer flow={flow} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Header({ head, flow, model, terminal, onDismiss }: { head: ArchHead; flow: FlowRun | null; model: ArchModel | null; terminal: boolean; onDismiss: () => void }) {
  const live = !terminal;
  const current = model?.current ? model.nodes.find((n) => n.id === model.current) : null;
  const have = new Set(flow?.stages.map((s) => s.key) ?? []);
  const last = flow?.stages[flow.stages.length - 1]?.key;
  const lastIdx = last ? STAGES.indexOf(last) : -1;
  return (
    <div className="pointer-events-auto relative z-10 mx-auto w-full max-w-[560px] px-2">
      <div className="flex items-center gap-2.5">
        <span className="relative flex size-2">
          {live && <span className="absolute inset-0 animate-ping rounded-full bg-[#9eeaff] opacity-60" />}
          <span className="relative size-2 rounded-full" style={{ background: live ? '#9eeaff' : flow?.verdict ? HEX[flow.verdict.tone] : '#6e7b83' }} />
        </span>
        <span className="label !text-[9.5px]">Recovery architecture</span>
        <span className="h-px flex-1 bg-gradient-to-r from-line-2 to-transparent" />
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] ${head.source === 'fleet' ? 'border-replay/35 text-replay' : 'border-info/30 text-info'}`}>
          {head.source === 'fleet' ? 'Replay · real fleet' : 'Simulated twin'}
        </span>
        <button onClick={onDismiss} disabled={live} title={live ? 'The run is still in progress' : 'Close and return to the War Room'} aria-label="Close the architecture" className="grid size-7 place-items-center rounded-full text-ink-3 transition hover:bg-white/5 hover:text-ink disabled:opacity-0">
          <svg viewBox="0 0 24 24" className="size-3.5 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <h3 className="mt-1 truncate text-[17px] font-medium leading-snug text-ink">
        {head.title}{head.target && <span className="font-normal text-ink-3"> · {head.target}</span>}
      </h3>
      <div className="mt-1 flex min-h-[18px] items-center gap-2 font-mono text-[10.5px]">
        {head.controllerReal
          ? <span className="shrink-0 text-accent" title="The controller that chose every tool call in this recording">NVIDIA {head.controller}</span>
          : <span className="shrink-0 text-ink-3" title={head.controller}>Rule-based stand-in · Nemotron not connected</span>}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={current ? `${current.id}:${current.verb}` : terminal ? 'end' : 'wait'} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25 }} className="min-w-0 truncate text-ink-2">
            {current ? <><span className="text-ink-4">· now </span><span className="text-[#9eeaff]">{current.title}</span>{current.verb ? <span className="text-ink-3"> · {current.verb}</span> : null}</>
              : terminal && flow?.verdict ? <><span className="text-ink-4">· </span><span style={{ color: HEX[flow.verdict.tone] }}>{flow.verdict.label}</span></>
              : !flow ? <span className="text-ink-4">· failure injected · waiting for monitoring to notice</span> : null}
          </motion.span>
        </AnimatePresence>
      </div>
      {/* Progress: one tick per stage the run has actually reached. */}
      <ol className="mt-2.5 flex items-center gap-1" aria-label="Stages">
        {STAGES.map((k, i) => {
          const reached = have.has(k);
          const skipped = !reached && i < lastIdx;
          const current = k === last && !terminal;
          return (
            <li key={k} className="flex flex-1 flex-col gap-1" title={skipped ? `${LABEL[k]} · not used in this run` : LABEL[k]}>
              <span className={`relative h-[3px] overflow-hidden rounded-full ${skipped ? 'bg-white/[0.04]' : 'bg-white/[0.08]'}`}>
                <motion.span className="absolute inset-y-0 left-0 rounded-full" initial={false} animate={{ width: reached ? '100%' : '0%' }} transition={{ duration: 0.7, ease }}
                  style={{ background: k === 'certificate' && flow?.verdict ? HEX[flow.verdict.tone] : current ? '#9eeaff' : '#76b900', boxShadow: current ? '0 0 10px #9eeaff' : undefined }} />
              </span>
              <span className={`hidden truncate font-mono text-[8.5px] uppercase tracking-[0.1em] xl:block ${reached ? (current ? 'text-[#9eeaff]' : 'text-ink-3') : 'text-ink-4/60'}`}>{LABEL[k]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Keeps its children pinned to a module of the 3D board. */
function Anchor({ scene, id, side, children }: { scene: ArchScene; id: ArchId; side: 'right' | 'below' | 'left'; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current;
      if (el) {
        const p = scene.screenPos(id, side === 'below' ? 'bottom' : 'top');
        const w = el.offsetWidth, h = el.offsetHeight;
        const parent = el.parentElement!;
        let x = side === 'below' ? p.x - w / 2 : side === 'right' ? p.x + 46 : p.x - w - 46;
        let y = side === 'below' ? p.y + 38 : p.y - h / 2 + 12;
        x = Math.max(6, Math.min(parent.clientWidth - w - 6, x));
        y = Math.max(6, Math.min(parent.clientHeight - h - 6, y));
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        el.style.opacity = p.visible ? '1' : '0';
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [scene, id, side]);
  return <div ref={ref} className="pointer-events-auto absolute left-0 top-0 z-10 opacity-0 transition-opacity duration-500">{children}</div>;
}

function CertButton({ hex, label, onClick }: { hex: string; label: string; onClick: () => void }) {
  return (
    <motion.button
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: 1.2, duration: 0.7, ease }}
      onClick={onClick}
      className="group relative flex items-center gap-2 overflow-hidden whitespace-nowrap rounded-full px-4 py-2 text-[12.5px] font-semibold backdrop-blur-md"
      style={{ background: `linear-gradient(180deg, ${hex}33, ${hex}12)`, boxShadow: `inset 0 0 0 1px ${hex}70, 0 0 36px -10px ${hex}`, color: hex === '#9aa6ad' ? '#e3e9ec' : hex }}
    >
      <span className="pointer-events-none absolute inset-0 animate-[shimmer_3.5s_linear_infinite] bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.16)_50%,transparent_70%)] bg-[length:200%_100%]" />
      <svg viewBox="0 0 24 24" className="relative size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="9.5" r="5.5" /><path d="m9 14.3-1.5 6.2L12 18l4.5 2.5-1.5-6.2" /></svg>
      <span className="relative">View Recovery Certificate</span>
      <span className="relative font-mono text-[9.5px] uppercase tracking-[0.12em] opacity-75">· {label}</span>
    </motion.button>
  );
}

/** Facility faults software cannot fix stay open after the run; a technician closes them. */
function FieldRepair({ scene, flow }: { scene: ArchScene; flow: FlowRun }) {
  const faults = useStore((s) => s.frame?.faults);
  const replay = useStore((s) => s.mode === 'replay');
  const open = !replay ? (faults ?? []).filter((f) => f.resolved_at == null) : [];
  if (!open.length || flow.terminal === 'VERIFIED') return null;
  const repair = () => Promise.all(open.map((f) => api.repair(f.id)))
    .then(() => toast(`Field repair recorded: ${open.map((f) => f.title).join(', ')}`, 'ok'))
    .catch((e) => toast(e.message, 'bad'));
  return (
    <Anchor scene={scene} id="certificate" side="right">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.6 }} className="glass w-[230px] rounded-2xl p-3">
        <p className="text-[11.5px] leading-relaxed text-ink-2">Still open: {open.map((f) => f.title).join(', ')}. Software does not fix cooling, power or hardware.</p>
        <button onClick={repair} className="mt-2 rounded-full border border-line-2 px-3 py-1 text-[11.5px] text-ink transition hover:bg-white/5">Record the technician's field repair</button>
      </motion.div>
    </Anchor>
  );
}

/** Details of one module: what it is, what it did, and the raw calls behind it. */
function Popover({ scene, node, flow, onClose }: { scene: ArchScene; node: ArchNode; flow: FlowRun | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current;
      if (el) {
        const p = scene.screenPos(node.id);
        const parent = el.parentElement!;
        const w = el.offsetWidth, h = el.offsetHeight;
        const right = p.x < parent.clientWidth / 2;
        let x = right ? p.x + 48 : p.x - w - 48;
        let y = p.y - 30;
        x = Math.max(6, Math.min(parent.clientWidth - w - 6, x));
        y = Math.max(6, Math.min(parent.clientHeight - h - 6, y));
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [scene, node.id]);
  const shadow = node.id === 'shadow' ? flow?.stages.find((s) => s.key === 'shadow') : null;
  const grouping = (node.id === 'tooldoc' || node.id === 'infradoc') && flow?.source === 'fleet';
  return (
    <div ref={ref} className="pointer-events-auto absolute left-0 top-0 z-20">
      <motion.div
        role="dialog" aria-label={node.title}
        initial={{ opacity: 0, scale: 0.94, filter: 'blur(6px)' }}
        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
        transition={{ duration: 0.35, ease }}
        className="glass-strong w-[min(340px,calc(100vw-40px))] overflow-hidden rounded-[20px]"
      >
        <div className="flex items-start gap-3 px-4 pb-2.5 pt-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-ink">{node.title}</span>
              {node.tag && <span className="rounded-full border border-line-2 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-[0.12em] text-ink-3">{node.tag}</span>}
            </div>
            <div className="mt-0.5 font-mono text-[10.5px]"><span className={STATE_CLS[node.state]}>{node.state === 'context' && NEXUS.includes(node.id) ? 'available · not chosen' : STATE_TEXT[node.state]}</span>{node.verb && node.state !== 'ghost' ? <span className="text-ink-3"> · {node.verb}</span> : null}</div>
            <div className="mt-0.5 text-[11.5px] text-ink-3">{node.sub}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition hover:bg-white/5 hover:text-ink">
            <svg viewBox="0 0 24 24" className="size-3.5 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="max-h-[42vh] overflow-y-auto border-t border-line px-2.5 pb-2.5 pt-2">
          {node.replicas?.length ? (
            <div className="mb-2 flex flex-wrap gap-1 px-1.5">
              {node.replicas.map((r) => (
                <span key={r.id} className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${r.tone === 'bad' ? 'border-bad/40 text-bad' : r.tone === 'warn' ? 'border-warn/40 text-warn' : r.tone === 'info' ? 'border-info/40 text-info' : r.tone === 'off' ? 'border-line-2 text-ink-4' : 'border-ok/30 text-ok'}`}>{r.id}</span>
              ))}
            </div>
          ) : null}
          {shadow?.candidates?.length ? <div className="px-1"><Candidates list={shadow.candidates} chosen={shadow.chosen ?? null} /></div> : null}
          {grouping && <p className="mb-1.5 px-1.5 text-[10.5px] leading-relaxed text-ink-4">One Nemotron model, one tool registry; calls are grouped here by what they inspect.</p>}
          {node.items.length ? (
            <ul className="space-y-0.5">{node.items.map((it) => <Item key={it.id} it={it} />)}</ul>
          ) : (
            <p className="px-1.5 py-1 text-[11.5px] text-ink-4">{node.state === 'ghost' ? 'This run did not use this module.' : NEXUS.includes(node.id) && node.state === 'context' ? 'The controller has this collection; it has not called any of its tools in this run.' : node.state === 'context' || node.state === 'fault' ? 'Part of the system under repair. No tool has read it yet.' : 'No recorded calls yet.'}</p>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function Footer({ flow }: { flow: FlowRun | null }) {
  return (
    <div className="pointer-events-none relative z-10 flex items-center justify-center gap-3 px-2 pt-1 font-mono text-[10px] text-ink-4">
      {flow ? <span>{flow.counts.tools} tool calls · {flow.counts.evidence} evidence{flow.startedAt ? ` · since ${flow.startedAt}` : ''}</span> : <span>nothing has run yet</span>}
      <span className="text-ink-4/70">· click a module for its calls</span>
    </div>
  );
}

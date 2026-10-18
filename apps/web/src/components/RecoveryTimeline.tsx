import { AnimatePresence, motion } from 'framer-motion';
import { OUTCOME, runView, type Stage, type StageStatus } from '../lib/stages';
import type { DoctorSnapshot } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

const DOT: Record<StageStatus, string> = {
  pending: 'border-white/15 bg-transparent',
  active: 'border-accent bg-accent shadow-[0_0_14px_2px_rgba(118,185,0,0.55)]',
  waiting: 'border-warn bg-warn shadow-[0_0_14px_2px_rgba(245,158,11,0.5)]',
  done: 'border-accent/80 bg-accent/80',
  failed: 'border-bad bg-bad shadow-[0_0_14px_2px_rgba(244,63,94,0.5)]',
  halted: 'border-warn bg-warn/80',
};

export function RecoveryTimeline({ run, onOutcome }: { run: DoctorSnapshot | null; onOutcome: () => void }) {
  return (
    <AnimatePresence>
      {run && <Timeline key={run.id} run={run} onOutcome={onOutcome} />}
    </AnimatePresence>
  );
}

function Timeline({ run, onOutcome }: { run: DoctorSnapshot; onOutcome: () => void }) {
  const view = runView(run);
  const focus = view.stages[view.current];
  const fill = view.current / (view.stages.length - 1);
  const outcome = view.terminal ? OUTCOME[view.terminal] : null;
  const trackColor = view.terminal === 'ROLLED_BACK' ? 'bg-bad' : view.terminal && view.terminal !== 'VERIFIED' ? 'bg-warn' : 'bg-accent';

  return (
    <motion.section
      initial={{ y: 40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 30, opacity: 0, transition: { duration: 0.3 } }}
      transition={{ duration: 0.7, ease }}
      className="glass pointer-events-auto absolute bottom-5 left-1/2 z-20 w-[min(860px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl px-5 pb-4 pt-3.5"
      aria-label="Recovery progress"
    >
      <div className="flex items-center gap-3">
        <span className="relative flex size-2">
          {!run.terminal && <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-70" />}
          <span className={`relative size-2 rounded-full ${run.terminal ? (outcome?.tone === 'ok' ? 'bg-ok' : outcome?.tone === 'bad' ? 'bg-bad' : 'bg-warn') : 'bg-accent'}`} />
        </span>
        <div className="min-w-0 flex-1 truncate text-[13px]">
          <span className="font-semibold text-ink">{run.title}</span>
          <span className="text-ink-3"> · {run.incident.title ?? run.signal.alarms.join(', ')}</span>
        </div>
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4 md:block" title={run.controller}>rule-based stand-in · Nemotron not connected</span>
        {outcome && (
          <motion.button
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={onOutcome}
            className={`rounded-lg border px-2.5 py-1 text-[12px] font-medium transition hover:bg-white/5 ${outcome.tone === 'ok' ? 'border-ok/50 text-ok' : outcome.tone === 'bad' ? 'border-bad/50 text-bad' : 'border-warn/50 text-warn'}`}
          >
            {outcome.label} · View proof
          </motion.button>
        )}
      </div>

      {/* The track runs between the first and last node centres (1/12 in from each side of a 6-column grid). */}
      <div className="relative mt-4">
        <div className="absolute top-[5px] h-px bg-white/10" style={{ left: '8.333%', right: '8.333%' }} />
        <motion.div
          className={`absolute top-[5px] h-px ${trackColor}`}
          style={{ left: '8.333%' }}
          initial={false}
          animate={{ width: `${83.333 * fill}%` }}
          transition={{ duration: 0.9, ease }}
        />
        <ol className="relative grid grid-cols-6">
          {view.stages.map((s, i) => <StageNode key={s.key} stage={s} index={i} />)}
        </ol>
      </div>

      <div className="mt-3 min-h-[20px] border-t border-line pt-2.5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={`${focus.key}:${run.terminal ? 'end' : focus.detail}`}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.28 }}
            className="truncate font-mono text-[11.5px] text-ink-2"
          >
            {run.terminal ? (
              <><span className={outcome?.tone === 'ok' ? 'text-ok' : outcome?.tone === 'bad' ? 'text-bad' : 'text-warn'}>{run.terminal.replace('_', ' ')}</span> · {run.terminal_reason}</>
            ) : run.awaiting_approval ? (
              <span className="text-warn">Waiting for your authorization before changing the fleet</span>
            ) : (
              <><span className="text-accent">{focus.label}</span> · {focus.detail ?? focus.hint}</>
            )}
          </motion.p>
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

function StageNode({ stage, index }: { stage: Stage; index: number }) {
  const live = stage.status === 'active' || stage.status === 'waiting';
  return (
    <li className="flex flex-col items-center gap-2 text-center">
      <span className="relative grid size-[11px] place-items-center">
        {live && (
          <motion.span
            className={`absolute inset-[-6px] rounded-full border ${stage.status === 'waiting' ? 'border-warn/60' : 'border-accent/60'}`}
            animate={{ scale: [0.7, 1.35], opacity: [0.9, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <motion.span
          layout
          className={`size-[11px] rounded-full border-[1.5px] transition-colors duration-500 ${DOT[stage.status]}`}
          initial={false}
          animate={{ scale: live ? 1.15 : 1 }}
        />
        {stage.status === 'failed' && <span className="absolute font-mono text-[8px] font-bold text-black">×</span>}
      </span>
      <span className={`text-[12px] transition-colors duration-500 ${stage.status === 'pending' ? 'text-ink-4' : live ? 'font-medium text-ink' : stage.status === 'failed' ? 'text-bad' : stage.status === 'halted' ? 'text-warn' : 'text-ink-2'}`}>
        {stage.label}
      </span>
      <span className="sr-only">{`Stage ${index + 1}: ${stage.status}`}</span>
    </li>
  );
}

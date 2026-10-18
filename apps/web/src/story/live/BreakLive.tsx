// "Break it live": starts a named fault on the real Brev fleet as a full agent episode.
// Only rendered while the operator is reachable (useLiveStatus). The faults on top are
// the ones the agent handles cleanly on held-out v2; the rest sit behind "More faults".
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../../lib/api';
import type { RealFault } from '../../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

export const HERO: { fault: string; title: string; text: string }[] = [
  { fault: 'vllm-32926-b', title: 'Silent tool-call failure', text: 'target-b keeps answering 200 OK, with no tool calls in it.' },
  { fault: 'kill-a', title: 'Worker crash', text: 'target-a’s vLLM process is killed.' },
  { fault: 'noauto-a', title: 'Missing auto tool choice', text: 'target-a restarts without --enable-auto-tool-choice.' },
  { fault: 'compound-killb-32926a', title: 'Two faults at once', text: 'target-b is killed while target-a breaks silently.' },
];

export function BreakLive({ busy, onPick }: { busy: boolean; onPick: (fault: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen((o) => !o)} disabled={busy}
        className="flex items-center gap-2 rounded-xl border border-bad/40 bg-bad/10 px-3 py-1.5 text-[13px] font-semibold text-bad transition-colors hover:bg-bad/20 disabled:cursor-not-allowed disabled:opacity-50">
        <span className="relative flex size-2">
          {!busy && <span className="absolute inset-0 animate-ping rounded-full bg-bad opacity-70" />}
          <span className="relative size-2 rounded-full bg-bad" />
        </span>
        {busy ? 'Live run in progress' : 'Break it live'}
      </button>
      <AnimatePresence>{open && !busy && <Chooser onPick={(f) => { setOpen(false); onPick(f); }} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function Chooser({ onPick, onClose }: { onPick: (fault: string) => void; onClose: () => void }) {
  const [more, setMore] = useState(false);
  const [all, setAll] = useState<RealFault[] | null>(null);
  useEffect(() => { if (more && !all) api.liveFaults().then(setAll).catch(() => setAll([])); }, [more, all]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const rest = (all ?? []).filter((f) => !HERO.some((h) => h.fault === f.name));
  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35, ease }}
      className="glass-strong absolute right-4 top-[76px] z-30 max-h-[70vh] w-[440px] overflow-y-auto rounded-2xl bg-bg/90 p-2">
      <div className="px-3 pb-1 pt-2">
        <div className="label">Break the real fleet · Brev H100</div>
        <p className="mt-1 text-[12.5px] leading-snug text-ink-3">Resets both workers, injects the fault, and lets Nemotron diagnose and repair it. A referee scores the result. Takes a few minutes.</p>
      </div>
      {HERO.map((h) => (
        <button key={h.fault} onClick={() => onPick(h.fault)} className="flex w-full flex-col rounded-xl px-3 py-2.5 text-left hover:bg-white/[0.05]">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-[14px] font-semibold text-ink">{h.title}</span>
            <span className="font-mono text-[11px] text-ink-4">{h.fault}</span>
          </span>
          <span className="mt-0.5 text-[12.5px] text-ink-3">{h.text}</span>
        </button>
      ))}
      <button onClick={() => setMore((m) => !m)} className="mt-1 w-full rounded-xl px-3 py-2 text-left text-[12.5px] text-ink-3 hover:bg-white/[0.04] hover:text-ink-2">
        {more ? '▾' : '▸'} More faults
      </button>
      {more && (all === null ? <div className="px-3 py-2 text-[12.5px] text-ink-4">Loading…</div> : rest.map((f) => (
        <button key={f.name} onClick={() => onPick(f.name)} className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left hover:bg-white/[0.05]">
          <span className="font-mono text-[12.5px] text-ink-2">{f.name}</span>
          {f.heldout && <span className="rounded-md border border-line-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">held-out</span>}
        </button>
      )))}
    </motion.div>
  );
}

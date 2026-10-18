import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { datacenter } from '../domains';
import { api } from '../lib/api';
import { toast } from '../lib/bus';
import { store } from '../lib/store';
import type { FaultSpec } from '../lib/types';

const CATEGORY_HUE: Record<string, string> = {
  'Tool calling': '#f59e0b',
  Compute: '#f97316',
  Workload: '#a78bfa',
  Network: '#38bdf8',
  'GPU & hardware': '#d946ef',
  'Power & cooling': '#f43f5e',
  Cascading: '#fb7185',
};

const EPISODE: Record<string, { text: string; tip: string }> = {
  real: { text: 'Reproduced on Brev', tip: 'A controlled episode of this failure exists on the live vLLM target. Here it is injected into the twin.' },
  hybrid: { text: 'Hybrid', tip: 'Partly reproduced on the live target, partly simulated telemetry.' },
  simulated: { text: 'Twin only', tip: 'Simulated telemetry; there is no live episode of this failure.' },
};

export function BreakOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [faults, setFaults] = useState<FaultSpec[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { api.faults().then(setFaults).catch((e) => toast(`Could not load failures: ${e.message}`, 'bad')); }, []);

  const groups = useMemo(() => {
    const cats = datacenter.categories ?? [];
    return cats
      .map((c) => ({ label: c.label, items: faults.filter((f) => f.category === c.match) }))
      .filter((g) => g.items.length);
  }, [faults]);
  const flat = groups.flatMap((g) => g.items.map((f) => ({ f, group: g.label })));

  const inject = async (f: FaultSpec) => {
    if (busy) return;
    setBusy(f.kind);
    try {
      if (store.get().replay) store.exitReplay();
      const res = await api.inject(f.kind);
      onClose();
      toast(`${res.title} injected${res.target ? ` · ${res.target}` : ''}`, 'bad');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const n = Number(e.key);
      if (n >= 1 && n <= flat.length) inject(flat[n - 1].f);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex items-center justify-center p-4 md:p-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.25 } }}
        >
          <motion.div
            className="absolute inset-0 bg-black/55 backdrop-blur-[6px]"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            role="dialog"
            aria-modal
            aria-label="Break the system"
            className="glass-strong relative flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-3xl"
            initial={{ y: 28, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 16, scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="pointer-events-none absolute -top-40 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-bad/15 blur-3xl" />
            <header className="relative flex items-start justify-between gap-6 px-7 pb-4 pt-7">
              <div>
                <span className="label !text-bad/80">Chaos</span>
                <h2 className="mt-1.5 text-[28px] font-semibold tracking-tight">Break the system</h2>
                <p className="mt-1 max-w-xl text-[14px] text-ink-2">Pick a failure to inject into the simulated datacenter. The right doctor notices on its own, investigates, and has to prove its repair.</p>
              </div>
              <button onClick={onClose} aria-label="Close" className="grid size-10 shrink-0 place-items-center rounded-xl text-ink-3 transition hover:bg-white/5 hover:text-ink">
                <svg viewBox="0 0 24 24" className="size-4 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </header>
            <div className="relative grid gap-3 overflow-y-auto px-7 pb-7 sm:grid-cols-2 lg:grid-cols-3">
              {flat.map(({ f, group }, i) => (
                <FaultCard key={f.kind} f={f} group={group} index={i} busy={busy === f.kind} onPick={() => inject(f)} />
              ))}
              {!flat.length && <p className="text-ink-3">Loading failures…</p>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FaultCard({ f, group, index, busy, onPick }: { f: FaultSpec; group: string; index: number; busy: boolean; onPick: () => void }) {
  const hue = CATEGORY_HUE[group] ?? '#38bdf8';
  const doctor = datacenter.doctorFor?.(f) === 'tool' ? 'Tool-Calling Doctor' : 'Infrastructure Doctor';
  const ep = EPISODE[f.live_episode ?? 'simulated'];
  return (
    <motion.button
      onClick={onPick}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.12 + index * 0.04, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.985 }}
      style={{ '--hue': hue } as CSSProperties}
      className="group relative flex flex-col gap-2.5 overflow-hidden rounded-2xl border border-line bg-white/[0.025] p-4 text-left transition-colors hover:border-[color-mix(in_srgb,var(--hue)_55%,transparent)] hover:bg-white/[0.045]"
    >
      <span className="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-40" style={{ background: hue }} />
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em]" style={{ color: hue }}>
          <span className="size-1.5 rounded-full" style={{ background: hue, boxShadow: `0 0 8px ${hue}` }} />
          {group}
        </span>
        <kbd className="font-mono text-[10px] text-ink-4">{index + 1}</kbd>
      </div>
      <div>
        <h3 className="text-[16px] font-semibold leading-snug text-ink">{f.title}</h3>
        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-2">{f.summary}</p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 font-mono text-[10.5px] text-ink-3">
        <span title={ep.tip}>{ep.text}</span>
        {f.candidate_id && <span className="text-ink-4">{f.candidate_id}</span>}
        <span className="ml-auto text-ink-2">→ {doctor}</span>
      </div>
      {busy && <motion.span layoutId="inject-bar" className="absolute inset-x-0 bottom-0 h-0.5" style={{ background: hue }} />}
    </motion.button>
  );
}

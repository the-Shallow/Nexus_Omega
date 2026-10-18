// The engineers' ending: the simulated datacenter behind a short "what if". The numbers
// are the real agent's (evidence/heldout, evidence/agent/known-after.json); the hall is not.
// Sits under the header, unfolds downward on load, and collapses to its title.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const ease = [0.16, 1, 0.3, 1] as const;

const STATS = [
  { v: '0', l: 'false “fixed” claims in 36 runs after the harness change' },
  { v: '9/12', l: 'on unseen faults; hand-written rules get 3/12' },
  { v: '3B', l: 'active parameters, on the H100 it repairs' },
];

export function WhatIf() {
  const [open, setOpen] = useState(true);
  // Only the first unfold waits for the scene to settle; later toggles answer at once.
  const first = useRef(true);
  useEffect(() => { const t = setTimeout(() => { first.current = false; }, 2000); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  const delay = first.current ? 0.9 : 0;

  return (
    <motion.section initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease, delay: 0.4 }}
      aria-label="What if"
      className="glass-strong pointer-events-auto absolute left-4 top-[92px] z-40 flex max-h-[calc(100vh-116px)] w-[min(392px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl md:left-6">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full shrink-0 px-4 pb-3 pt-3 text-left">
        <span className="flex items-center gap-2">
          <span className="label">What’s next</span>
          <span className="rounded-md border border-replay/30 bg-replay/10 px-1.5 py-0.5 font-mono text-[9.5px] tracking-wider text-replay">SIMULATED</span>
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.4, ease }}
            className="ml-auto grid size-7 place-items-center rounded-lg border border-line-2 text-[13px] text-ink-2 hover:bg-white/[0.06] hover:text-ink">▾</motion.span>
        </span>
        <span className="mt-1.5 block text-[18px] font-semibold leading-snug tracking-tight">What if a whole datacenter ran like this?</span>
      </button>
      <AnimatePresence initial>
        {open && (
          <motion.div key="body" className="min-h-0 overflow-y-auto"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1, transition: { height: { duration: 0.75, ease, delay }, opacity: { duration: 0.5, delay: delay + 0.15 } } }}
            exit={{ height: 0, opacity: 0, transition: { height: { duration: 0.45, ease }, opacity: { duration: 0.2 } } }}>
            <div className="space-y-2.5 px-4 text-[13.5px] leading-relaxed text-ink-2">
              <p><span className="text-ink">It won’t be easy.</span> Out of the box, our small model said a fix had worked when it hadn’t, 3 times in 12.</p>
              <p>We didn’t reach for a bigger model. We built a stricter harness around the same one, and let an independent referee decide what counts as fixed.</p>
              <p>Scale that harness to power, cooling and GPU faults, and you get this hall: a 512-GPU pod where every repair is checked before it counts.</p>
            </div>
            <dl className="mx-4 mt-4 grid grid-cols-3 gap-1.5">
              {STATS.map((s) => (
                <div key={s.v} className="rounded-xl bg-white/[0.04] px-2.5 py-2">
                  <dt className="font-mono text-[18px] font-semibold text-ok tnum">{s.v}</dt>
                  <dd className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{s.l}</dd>
                </div>
              ))}
            </dl>
            <div className="mx-4 mt-4 flex items-center gap-2 text-[12.5px] font-medium">
              <a href="results.html" className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-bg">See the real results</a>
              <span className="ml-auto font-mono text-[10.5px] text-ink-4">press B to break the hall</span>
            </div>
            <p className="mx-4 mb-3.5 mt-3 border-t border-line pt-2.5 font-mono text-[10px] leading-snug text-ink-4">
              Hall, power and cooling are simulated (SimPy, uncalibrated). The numbers are real runs on Brev.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

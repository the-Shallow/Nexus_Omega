// The engineers' ending: the simulated datacenter behind a short "what if". The numbers
// are the real agent's (evidence/heldout, evidence/agent/known-after.json); the hall is not.
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const ease = [0.16, 1, 0.3, 1] as const;

const STATS = [
  { v: '0', l: 'false “fixed” claims after the harness change, 36 runs' },
  { v: '9/12', l: 'on unseen faults, where hand-written rules get 3/12' },
  { v: '3B', l: 'active parameters, sharing one H100 with its fleet' },
];

export function WhatIf() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="shade" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.8 }}
            className="pointer-events-none absolute inset-y-0 left-0 z-30 w-[720px] max-w-full bg-gradient-to-r from-bg/90 via-bg/50 to-transparent" />
          <motion.section key="card" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.9, ease, delay: 0.4 }}
            aria-label="What if" className="glass-strong pointer-events-auto absolute left-4 top-1/2 z-40 w-[min(500px,calc(100vw-2rem))] -translate-y-1/2 rounded-2xl p-6 md:left-8">
            <div className="flex items-center justify-between gap-3">
              <span className="label">What’s next</span>
              <span className="rounded-lg border border-replay/30 bg-replay/10 px-2.5 py-1 font-mono text-[10.5px] tracking-wider text-replay">SIMULATED</span>
            </div>
            <h1 className="mt-3 text-[28px] font-semibold leading-[1.1] tracking-tight">What if a whole datacenter ran like this?</h1>
            <div className="mt-4 space-y-3 text-[14.5px] leading-relaxed text-ink-2">
              <p><span className="text-ink">It won’t be easy.</span> Out of the box, our small model said a fix had worked when it hadn’t, 3 times in 12.</p>
              <p>We didn’t reach for a bigger model. We built a stricter harness around the same one: look at one resource at a time, choose from moves that code builds, and let an independent referee decide what counts as fixed.</p>
              <p>Scale that harness from two vLLM workers to power, cooling and GPU faults, and you get the hall behind this card: a 512-GPU pod where every repair is checked before it counts.</p>
            </div>
            <dl className="mt-5 grid grid-cols-3 gap-2">
              {STATS.map((s) => (
                <div key={s.v} className="rounded-xl bg-white/[0.04] px-3 py-2.5">
                  <dt className="font-mono text-[22px] font-semibold text-ok tnum">{s.v}</dt>
                  <dd className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{s.l}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 flex flex-wrap items-center gap-2 text-[13px] font-medium">
              <button onClick={() => setOpen(false)} className="rounded-xl bg-accent px-3.5 py-2 font-semibold text-bg">Explore the simulation</button>
              <a href="results.html" className="rounded-xl bg-white/[0.07] px-3.5 py-2 hover:bg-white/[0.1]">See the real results</a>
              <span className="ml-auto font-mono text-[11px] text-ink-4">then press B to break it</span>
            </div>
            <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] leading-snug text-ink-4">
              Hall, power and cooling are simulated (SimPy, uncalibrated). The numbers above are real runs on Brev.
            </p>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}

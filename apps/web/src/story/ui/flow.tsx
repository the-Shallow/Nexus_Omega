// The end of every story: a plain-language route of what happened, when, and who
// confirmed it. Same facts as the steps, laid out so anyone can retell the incident.
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ACTS, type FlowStop, type Story } from '../script/types';

const ease = [0.16, 1, 0.3, 1] as const;

const TONE = {
  fault: 'var(--color-warn)', work: 'var(--color-accent)', fix: 'var(--color-ok)',
} as const;
const VERDICT = {
  ok: { c: 'var(--color-ok)', mark: '✓' }, warn: { c: 'var(--color-warn)', mark: '!' },
  bad: { c: 'var(--color-bad)', mark: '✗' }, idle: { c: 'var(--color-ink-3)', mark: '–' },
} as const;

export function FlowMapPanel({ story, onReplay, onOther, otherLabel }: { story: Story; onReplay: () => void; onOther: () => void; otherLabel: string }) {
  const f = story.flow;
  const v = VERDICT[f.verdict.tone];
  const color = (s: FlowStop) => (s.tone === 'end' ? v.c : TONE[s.tone]);
  // The recap leads with the outcome and the shape of the incident; each step's detail folds open on request.
  const [details, setDetails] = useState(false);
  return (
    <motion.section initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} transition={{ duration: 0.9, ease, delay: 1.6 }}
      className="glass-strong absolute bottom-[72px] left-3 right-3 z-10 mx-auto max-w-[1180px] rounded-2xl px-5 pb-4 pt-4" aria-label="What happened">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="label">What happened</span>
        <h2 className="text-[17px] font-semibold tracking-tight">{f.title}</h2>
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold" style={{ color: v.c, borderColor: v.c }}>{v.mark} {f.verdict.label}</span>
        <button onClick={() => setDetails((d) => !d)} aria-expanded={details}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-line-2 px-2.5 py-1 text-[12px] text-ink-2 hover:bg-white/[0.05] hover:text-ink">
          {details ? 'Hide details' : 'Step details'}
          <motion.span animate={{ rotate: details ? 180 : 0 }} transition={{ duration: 0.35, ease }}>▾</motion.span>
        </button>
      </div>
      <div className="mt-4 overflow-x-auto pb-1">
        <ol className="grid min-w-[860px]" style={{ gridTemplateColumns: `repeat(${f.stops.length}, minmax(0, 1fr))` }}>
          {f.stops.map((s, i) => {
            const last = i === f.stops.length - 1;
            return (
              <motion.li key={s.title + i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: 1.9 + i * 0.1 }}
                className="relative pr-3 pt-6">
                <span className="absolute left-0 top-[7px] h-[2px]" style={{ right: last ? '50%' : 0, background: color(s), opacity: 0.85 }} />
                <span className={`absolute left-0 rounded-full border-2 ${last ? 'top-[-1px] size-[18px]' : 'top-[1px] size-3.5 bg-bg'}`} style={{ borderColor: color(s), background: last ? color(s) : undefined }} />
                <div className="font-mono text-[10.5px] text-ink-3 tnum">
                  {s.time ?? 'time not recorded'}{s.delta && <span className="ml-1.5 text-ink-2">{s.delta}</span>}
                </div>
                <h3 className="mt-0.5 text-[13.5px] font-semibold leading-tight">{s.title}</h3>
                <AnimatePresence initial={false}>
                  {details && (
                    <motion.div key="d" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      transition={{ height: { duration: 0.45, ease }, opacity: { duration: 0.3 } }} className="overflow-hidden">
                      <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{s.text}</p>
                      {s.code && <code className="mt-1 block font-mono text-[10.5px] text-ink-3">{s.code}</code>}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.li>
            );
          })}
        </ol>
      </div>
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3.5">
        <p className="max-w-[68ch] text-[13.5px] leading-snug text-ink">{f.meaning}</p>
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">
          <button onClick={onReplay} className="rounded-lg px-3 py-1.5 text-ink-2 hover:bg-white/[0.06] hover:text-ink">↺ Replay</button>
          <button onClick={onOther} className="rounded-lg px-3 py-1.5 text-ink-2 hover:bg-white/[0.06] hover:text-ink">{otherLabel}</button>
          <a href="platform.html" className="rounded-lg bg-white/[0.07] px-3 py-1.5 hover:bg-white/[0.1]">What’s next →</a>
          <a href="results.html" className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-bg">See all results</a>
        </div>
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10.5px] text-ink-4">
        <span>{f.meta}</span>
        <a href="about.html#how" className="hover:text-ink-2">How it works →</a>
      </div>
    </motion.section>
  );
}

/** A full-width title card at the start of each act. */
export function ActCard({ act }: { act: 1 | 2 | 3 }) {
  const a = ACTS[act - 1];
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.7, ease }}
      className="pointer-events-none absolute inset-y-0 left-[400px] right-0 z-10 grid place-items-center">
      <motion.div initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -10, opacity: 0 }} transition={{ duration: 0.8, ease }}
        className="rounded-2xl bg-bg/55 px-10 py-7 text-center backdrop-blur-md">
        <div className="font-mono text-[12px] tracking-[0.24em] text-accent">ACT {a.n}</div>
        <div className="mt-2 text-[40px] font-semibold leading-none tracking-tight">{a.title}</div>
        <div className="mt-3 text-[14px] text-ink-3">{a.sub}</div>
      </motion.div>
    </motion.div>
  );
}

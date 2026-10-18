// The end of every story: a plain-language route of what happened, when, and who
// confirmed it. Same facts as the steps, laid out so anyone can retell the incident.
import { motion } from 'framer-motion';
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
  return (
    <motion.section initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} transition={{ duration: 0.9, ease, delay: 1.6 }}
      className="glass-strong absolute bottom-24 left-4 right-4 z-10 rounded-2xl px-6 pb-5 pt-5" aria-label="What happened">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="flex items-baseline gap-3">
          <span className="label">What happened</span>
          <h2 className="text-[19px] font-semibold tracking-tight">{f.title}</h2>
        </div>
        <span className="font-mono text-[11.5px] text-ink-3">{f.meta}</span>
      </div>
      <div className="mt-5 overflow-x-auto pb-1">
        <ol className="grid min-w-[980px]" style={{ gridTemplateColumns: `repeat(${f.stops.length}, minmax(0, 1fr))` }}>
          {f.stops.map((s, i) => {
            const last = i === f.stops.length - 1;
            return (
              <motion.li key={s.title + i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: 1.9 + i * 0.12 }}
                className="relative pr-4 pt-7">
                <span className="absolute left-0 top-[9px] h-[2px]" style={{ right: last ? '50%' : 0, background: color(s), opacity: 0.85 }} />
                <span className={`absolute left-0 rounded-full border-2 ${last ? 'top-[-1px] size-[22px]' : 'top-[2px] size-4 bg-bg'}`} style={{ borderColor: color(s), background: last ? color(s) : undefined }} />
                <div className="font-mono text-[11px] text-ink-3 tnum">
                  {s.time ?? 'time not recorded'}{s.delta && <span className="ml-1.5 text-ink-2">{s.delta}</span>}
                </div>
                <h3 className="mt-1 text-[14.5px] font-semibold leading-tight">{s.title}</h3>
                <p className="mt-1 text-[13px] leading-snug text-ink-2">{s.text}</p>
                {s.code && <code className="mt-1 block font-mono text-[11px] text-ink-3">{s.code}</code>}
              </motion.li>
            );
          })}
        </ol>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="flex flex-wrap items-center gap-3 text-[14.5px] text-ink">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] font-semibold" style={{ color: v.c, borderColor: v.c }}>{v.mark} {f.verdict.label}</span>
          <span className="max-w-[70ch]">{f.meaning}</span>
        </p>
        <div className="flex flex-wrap gap-2 text-[13px] font-medium">
          <button onClick={onReplay} className="rounded-xl bg-white/[0.07] px-3.5 py-2 hover:bg-white/[0.1]">Replay</button>
          <button onClick={onOther} className="rounded-xl bg-white/[0.07] px-3.5 py-2 hover:bg-white/[0.1]">{otherLabel}</button>
          <a href="./#how" className="rounded-xl bg-white/[0.07] px-3.5 py-2 hover:bg-white/[0.1]">How it works</a>
          <a href="results.html" className="rounded-xl bg-accent px-3.5 py-2 font-semibold text-bg">See all results</a>
        </div>
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

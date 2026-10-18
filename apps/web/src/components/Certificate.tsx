import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../lib/api';
import { fleet } from '../lib/fleet';
import type { Tone } from '../lib/flow';
import { proofFromFleet, proofFromTwin, type Proof } from '../lib/proof';
import { useStore } from '../lib/store';
import type { Terminal } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;
const HEX: Record<Tone, string> = { ok: '#76b900', bad: '#f43f5e', warn: '#f5a524', muted: '#9aa6ad', info: '#38bdf8' };

export type CertRef = { kind: 'twin' | 'fleet'; id: string };

/** The proof of a run, whatever its outcome. Opened from the workflow, never automatically. */
export function CertificateOverlay({ cert, onClose }: { cert: CertRef | null; onClose: () => void }) {
  const [proof, setProof] = useState<Proof | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slo = useStore((s) => s.topo?.slo ?? null);
  const replay = useStore((s) => s.mode === 'replay');

  useEffect(() => {
    if (!cert) return;
    setProof(null); setError(null);
    let live = true;
    const load = cert.kind === 'twin'
      ? api.certificate(cert.id).then((s) => proofFromTwin(s, slo))
      : Promise.resolve(fleet.get().detail?.summary.id === cert.id ? fleet.get().detail! : null).then((d) => d ?? api.recording(cert.id)).then(proofFromFleet);
    load.then((p) => live && setProof(p)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [cert?.kind, cert?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cert) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [cert, onClose]);

  return (
    <AnimatePresence>
      {cert && (
        <motion.div className="absolute inset-0 z-[60] flex items-center justify-center p-3 md:p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.35 } }}>
          <motion.div className="absolute inset-0 bg-black/55 backdrop-blur-[6px]" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal
            aria-label="Recovery certificate"
            className="glass-strong relative flex max-h-full w-full max-w-[920px] flex-col overflow-hidden rounded-[32px]"
            initial={{ y: 40, scale: 0.96, opacity: 0, filter: 'blur(12px)' }}
            animate={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ y: 24, scale: 0.98, opacity: 0, filter: 'blur(8px)' }}
            transition={{ duration: 0.8, ease }}
          >
            <button autoFocus onClick={onClose} aria-label="Close" className="absolute right-4 top-4 z-10 grid size-10 place-items-center rounded-full text-ink-3 transition hover:bg-white/5 hover:text-ink">
              <svg viewBox="0 0 24 24" className="size-4 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
            <div className="overflow-y-auto">
              {proof ? <Body p={proof} replay={replay || cert.kind === 'fleet'} /> : (
                <div className="grid h-80 place-items-center text-[13px] text-ink-3">{error ? `Could not load the certificate: ${error}` : 'Loading the certificate…'}</div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Body({ p, replay }: { p: Proof; replay: boolean }) {
  const hex = HEX[p.tone];
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(p.footer.value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => undefined);
  const item = { initial: { opacity: 0, y: 12, filter: 'blur(4px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' } };
  return (
    <section className="relative px-6 pb-7 pt-7 md:px-9 md:pt-8">
      <div className="pointer-events-none absolute -left-32 -top-24 size-[30rem] rounded-full blur-3xl" style={{ background: hex, opacity: 0.11 }} />
      <motion.div className="relative" initial="initial" animate="animate" transition={{ staggerChildren: 0.07, delayChildren: 0.25 }}>
        <motion.div variants={item} className="flex flex-wrap items-center gap-x-3 gap-y-2 pr-10">
          <span className="label">Recovery certificate</span>
          <span className="font-mono text-[11px] text-ink-3">{p.id}</span>
          <span className="flex flex-wrap gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] md:ml-auto">
            <span className={`rounded-full border px-2 py-0.5 ${p.kind === 'fleet' ? 'border-replay/35 text-replay' : 'border-info/30 text-info'}`}>{p.data}</span>
            {p.controllerReal
              ? <span className="rounded-full border border-accent/35 px-2 py-0.5 text-accent">NVIDIA {p.controller}</span>
              : <span className="rounded-full border border-line-2 px-2 py-0.5 text-ink-3" title={p.controller}>Rule-based stand-in</span>}
            {replay && <span className="rounded-full border border-replay/35 px-2 py-0.5 text-replay">Replay</span>}
          </span>
        </motion.div>

        <motion.div variants={item} className="mt-6 flex flex-wrap items-center gap-6">
          <Seal terminal={p.falseVerified ? 'ROLLED_BACK' : p.terminal} hex={hex} cross={p.falseVerified} />
          <div className="min-w-0 flex-1">
            <h2 className="display text-[30px] font-medium leading-tight md:text-[36px]" style={{ color: hex }}>{p.label}</h2>
            {p.falseVerified && (
              <p className="mt-2 inline-flex items-center gap-2 rounded-full border border-bad/40 bg-bad/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-bad">
                <span className="size-1.5 rounded-full bg-bad" />executor: verified · referee: not fixed
              </p>
            )}
            <p className="mt-1.5 max-w-[560px] text-[14px] leading-relaxed text-ink-2">{p.reason}</p>
            <p className="mt-2 text-[14px] text-ink">
              {p.title}
              {p.target && <span className="text-ink-3"> · {p.target}</span>}
              {p.knownIssue && <span className="font-mono text-[11.5px] text-ink-3"> · {p.knownIssue}</span>}
              {p.failureType && p.failureType.toUpperCase() !== p.knownIssue && <span className="text-ink-3"> · {p.failureType}</span>}
            </p>
          </div>
        </motion.div>

        <motion.dl variants={item} className="mt-6 grid gap-x-6 gap-y-1.5 rounded-3xl border border-line bg-white/[0.015] px-4 py-3.5 md:grid-cols-[auto_1fr]">
          {p.facts.map((f) => (
            <div key={f.k} className="contents">
              <dt className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4 md:pt-[2px]">{f.k}</dt>
              <dd className="mb-1.5 font-mono text-[11px] leading-relaxed text-ink-2 [overflow-wrap:anywhere] md:mb-0">{f.v}</dd>
            </div>
          ))}
        </motion.dl>

        <motion.dl variants={item} className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-3xl border border-line bg-line md:grid-cols-4">
          {p.stats.map((s) => (
            <div key={s.k} className="bg-[#08101a]/95 px-4 py-3.5">
              <dt className="label !text-[9px]">{s.k}</dt>
              <dd className={`tnum mt-1 text-[21px] font-medium tracking-tight ${s.tone === 'warn' ? 'text-warn' : 'text-ink'}`}>{s.v}</dd>
              {s.sub && <dd className="truncate font-mono text-[10px] text-ink-3">{s.sub}</dd>}
            </div>
          ))}
        </motion.dl>

        <div className="mt-7 grid gap-7 lg:grid-cols-[1.15fr_1fr]">
          <motion.div variants={item}>
            <h4 className="label mb-3">Before → after</h4>
            {p.slo.length ? (
              <div className="overflow-hidden rounded-2xl border border-line">
                {p.slo.map((r, i) => (
                  <motion.div key={r.metric} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.6 + i * 0.06, ease }} className="grid grid-cols-[1.25fr_1fr_auto_1fr] items-center gap-2 border-b border-line px-3.5 py-2 last:border-b-0">
                    <span className="min-w-0 text-[12px] leading-tight text-ink-2">{r.metric}{r.limit && <span className="block font-mono text-[9.5px] text-ink-4">{r.limit}</span>}</span>
                    <span className="tnum text-right font-mono text-[11px] leading-tight text-ink-3 [overflow-wrap:anywhere]">{r.before}</span>
                    <span className="text-ink-4">→</span>
                    <span className={`tnum font-mono text-[11px] leading-tight [overflow-wrap:anywhere] ${r.ok === null ? 'text-ink-3' : r.ok ? 'text-ok' : 'text-bad'}`}>{r.after}</span>
                  </motion.div>
                ))}
              </div>
            ) : null}
            <p className="mt-2 text-[11px] leading-relaxed text-ink-4">{p.sloNote}</p>

            <h4 className="label mb-3 mt-6">Independent checks</h4>
            {p.checks.length ? (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {p.checks.map((c, i) => (
                  <motion.li key={c.name} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.8 + i * 0.06 }} className="flex items-start gap-2.5 rounded-2xl border border-line bg-white/[0.02] px-3 py-2">
                    <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold ${c.passed ? 'bg-ok/20 text-ok' : 'bg-bad/20 text-bad'}`}>{c.passed ? '✓' : '✕'}</span>
                    <span className="min-w-0"><span className="block text-[12px] text-ink">{c.name}</span>{c.detail && <span className="block truncate font-mono text-[10px] text-ink-3">{c.detail}</span>}</span>
                  </motion.li>
                ))}
              </ul>
            ) : <p className="text-[12.5px] text-ink-3">No verification was reached, so nothing is claimed as repaired.</p>}
          </motion.div>

          <motion.div variants={item}>
            <h4 className="label mb-3">Actions</h4>
            {p.actions.length ? (
              <ul className="space-y-1.5">
                {p.actions.map((a) => <li key={a} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-2"><span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-4" />{a}</li>)}
              </ul>
            ) : <p className="text-[12.5px] text-ink-3">No change was made.</p>}

            <h4 className="label mb-3 mt-6">Evidence</h4>
            <ol className="space-y-1.5 text-[12px]">
              {p.evidence.map((e) => (
                <li key={e.id} className="flex gap-2.5"><span className="shrink-0 pt-px font-mono text-[10px] text-ink-4">{e.id}</span><span className="text-ink-2">{e.finding}</span></li>
              ))}
            </ol>
            {p.summary && (
              <>
                <h4 className="label mb-2 mt-6">Diagnosis</h4>
                <p className="text-[12.5px] italic leading-relaxed text-ink-2">“{p.summary}”</p>
              </>
            )}
            {p.prediction && (
              <p className="mt-4 rounded-2xl border border-info/15 bg-info/[0.04] px-3 py-2 text-[11.5px] text-ink-3">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-info/80">Predicted vs measured · </span>
                the shadow twin's TTFT forecast was off by {Math.round(p.prediction.mae * 1000)} ms on average across {p.prediction.samples} samples after the repair.
              </p>
            )}
          </motion.div>
        </div>

        <motion.footer variants={item} className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <button onClick={copy} className="flex min-w-0 items-center gap-2 font-mono text-[10.5px] text-ink-3 hover:text-ink-2" title={`Copy ${p.footer.label}`}>
            <span>{p.footer.label}</span><span className="max-w-[260px] truncate text-ink-2">{p.footer.value}</span><span className="text-accent">{copied ? 'copied' : ''}</span>
          </button>
          <span className="ml-auto flex gap-2">
            <a href={p.jsonUrl} download className="rounded-full border border-line-2 px-4 py-2 text-[12px] text-ink transition hover:bg-white/[0.06]">Download JSON</a>
            <a href={p.pdfUrl} download className="rounded-full px-4 py-2 text-[12px] font-medium text-black transition hover:brightness-110" style={{ background: hex === '#9aa6ad' ? '#d6dde1' : hex }}>Download PDF</a>
          </span>
        </motion.footer>
      </motion.div>
    </section>
  );
}

function Seal({ terminal, hex, cross = false }: { terminal: Terminal; hex: string; cross?: boolean }) {
  return (
    <div className="relative grid size-[104px] shrink-0 place-items-center">
      <motion.svg viewBox="0 0 100 100" className="absolute inset-0" animate={terminal === 'VERIFIED' ? { rotate: 360 } : undefined} transition={{ duration: 50, repeat: Infinity, ease: 'linear' }}>
        <circle cx="50" cy="50" r="47" fill="none" stroke={hex} strokeOpacity="0.55" strokeDasharray="1.5 4.5" />
        <motion.circle cx="50" cy="50" r="40" fill="none" stroke={hex} strokeOpacity="0.25" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, delay: 0.3, ease: [0.65, 0, 0.35, 1] }} />
      </motion.svg>
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.55 }}
        className="grid size-[68px] place-items-center rounded-full"
        style={{ background: `radial-gradient(circle at 50% 35%, ${hex}55, transparent 72%)`, boxShadow: `inset 0 0 0 1px ${hex}88, 0 0 50px -8px ${hex}` }}
      >
        <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke={hex} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          {terminal === 'VERIFIED' && <motion.path d="M5 12.5 10 17l9-10" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 1, duration: 0.6 }} />}
          {cross && <motion.path d="M7 7l10 10M17 7 7 17" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 1, duration: 0.5 }} />}
          {terminal === 'ROLLED_BACK' && !cross && <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />}
          {terminal === 'REQUIRES_APPROVAL' && <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>}
          {terminal === 'ABSTAIN' && <path d="M8 6v12M16 6v12" />}
        </svg>
      </motion.div>
    </div>
  );
}

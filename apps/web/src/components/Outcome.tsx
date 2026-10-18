import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../lib/api';
import { dur, ms } from '../lib/format';
import { OUTCOME, verifiedService } from '../lib/stages';
import { store, useStore } from '../lib/store';
import type { Certificate, CertificateSummary, DoctorSnapshot, Terminal } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;
const TONE = {
  ok: { text: 'text-ok', border: 'border-ok/40', glow: 'rgba(118,185,0,0.35)', hex: '#76b900' },
  warn: { text: 'text-warn', border: 'border-warn/40', glow: 'rgba(245,158,11,0.3)', hex: '#f59e0b' },
  bad: { text: 'text-bad', border: 'border-bad/40', glow: 'rgba(244,63,94,0.3)', hex: '#f43f5e' },
  muted: { text: 'text-ink-2', border: 'border-line-2', glow: 'rgba(160,170,180,0.15)', hex: '#a3afb7' },
};

/** The end of a run: how the system worked through it, then the certificate. */
export function OutcomeSheet({ open, run, onClose }: { open: boolean; run: DoctorSnapshot | null; onClose: () => void }) {
  const [data, setData] = useState<CertificateSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = run?.certificate_id;

  useEffect(() => {
    if (!open || !id) return;
    setData(null); setError(null);
    api.certificate(id).then(setData).catch((e) => setError(e.message));
  }, [open, id]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && run && (
        <motion.div className="absolute inset-0 z-50 flex items-end justify-center p-3 md:items-center md:p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="absolute inset-0 bg-black/60 backdrop-blur-[5px]" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal
            aria-label="Recovery outcome"
            className="glass-strong relative flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-3xl"
            initial={{ y: 60, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.7, ease }}
          >
            <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 z-10 grid size-10 place-items-center rounded-xl text-ink-3 transition hover:bg-white/5 hover:text-ink">
              <svg viewBox="0 0 24 24" className="size-4 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
            <div className="overflow-y-auto">
              {data ? (
                <>
                  <ArchitectureFlow cert={data.certificate} run={run} />
                  <CertificateCard s={data} onClose={onClose} />
                </>
              ) : (
                <div className="grid h-80 place-items-center text-ink-3">{error ? `Could not load the certificate: ${error}` : 'Loading certificate…'}</div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------ architecture

interface FlowNode { k: string; title: string; value: string; sub?: string; reached: boolean; tone?: keyof typeof TONE }

function flowNodes(cert: Certificate, run: DoctorSnapshot): FlowNode[] {
  const tools = new Set(cert.tool_calls.map((c) => c.tool));
  const top = cert.hypotheses[0];
  const pc = cert.precheck;
  const rejected = cert.policy.filter((p) => p.decision === 'rejected').length;
  const approved = cert.policy.find((p) => p.decision === 'approved');
  const checks = cert.verification?.checks ?? [];
  const passed = checks.filter((c) => c.passed).length;
  const o = OUTCOME[cert.terminal_state];
  return [
    { k: 'signal', title: 'Signal', value: run.signal.alarms[0] ?? 'alarm', sub: run.signal.alarms.length > 1 ? `+${run.signal.alarms.length - 1} more` : 'twin telemetry', reached: true },
    { k: 'ctrl', title: 'Controller', value: 'Rule-based stand-in', sub: 'Nemotron not connected', reached: true },
    { k: 'doctor', title: 'Doctor', value: cert.doctor === 'tool' ? 'Tool-Calling' : 'Infrastructure', sub: `${cert.budget.used.steps} steps`, reached: true },
    { k: 'tools', title: 'Tool calls', value: `${cert.tool_calls.length} calls`, sub: `${tools.size} distinct tools`, reached: cert.tool_calls.length > 0 },
    { k: 'evidence', title: 'Evidence', value: `${cert.evidence.length} findings`, sub: top ? `${top.label.slice(0, 34)}${top.label.length > 34 ? '…' : ''}` : undefined, reached: cert.evidence.length > 0 },
    { k: 'twin', title: 'Shadow twin', value: pc ? `${pc.candidates.length} fixes × ${pc.seeds.length} seeds` : 'not run', sub: pc ? `${pc.horizon}s horizon` : undefined, reached: !!pc },
    { k: 'policy', title: 'Policy', value: approved ? 'approved' : 'no approval', sub: rejected ? `${rejected} rejected` : approved?.reason.slice(0, 30), reached: cert.policy.length > 0 },
    { k: 'repair', title: 'Repair', value: cert.repair.label ?? 'none', sub: cert.repair.rollback_exercised ? 'rolled back' : cert.repair.change_tokens.length ? `${cert.repair.change_tokens.length} change tokens` : undefined, reached: !!cert.repair.label },
    { k: 'verify', title: 'Verification', value: checks.length ? `${passed}/${checks.length} checks` : 'not reached', sub: checks.length ? (passed === checks.length ? 'all passed' : 'failed') : undefined, reached: checks.length > 0, tone: checks.length ? (passed === checks.length ? 'ok' : 'bad') : undefined },
    { k: 'cert', title: 'Certificate', value: o.label, sub: cert.certificate_id.slice(0, 22), reached: true, tone: o.tone },
  ];
}

const W = 1040, H = 300, NW = 158, NH = 70;
const POS = [[100, 72], [300, 72], [500, 72], [700, 72], [900, 72], [900, 228], [700, 228], [500, 228], [300, 228], [100, 228]];

function connector(i: number) {
  const [x1, y1] = POS[i], [x2, y2] = POS[i + 1];
  if (y1 === y2) {
    const dir = Math.sign(x2 - x1);
    return `M${x1 + (dir * NW) / 2} ${y1} L${x2 - (dir * NW) / 2} ${y2}`;
  }
  return `M${x1 + NW / 2} ${y1} C ${x1 + NW / 2 + 48} ${y1}, ${x2 + NW / 2 + 48} ${y2}, ${x2 + NW / 2 + 4} ${y2}`;
}

function ArchitectureFlow({ cert, run }: { cert: Certificate; run: DoctorSnapshot }) {
  const nodes = flowNodes(cert, run);
  const lastReached = nodes.reduce((m, n, i) => (n.reached ? i : m), 0);
  const full = POS.slice(0, -1).map((_, i) => connector(i)).join(' ');
  return (
    <section className="relative border-b border-line px-6 pb-6 pt-7 md:px-8">
      <span className="label">How Nexus worked through it</span>
      <h2 className="mt-1.5 text-[22px] font-semibold tracking-tight">One controller, one doctor, one proof</h2>
      <div className="mt-4 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[720px]">
          <defs>
            <filter id="flow-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" /></filter>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 7 4 1 7" fill="none" stroke="#76b900" strokeWidth="1.4" /></marker>
            <marker id="flow-arrow-off" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 7 4 1 7" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1.2" /></marker>
          </defs>
          {POS.slice(0, -1).map((_, i) => {
            const on = i < lastReached && nodes[i + 1].reached;
            return (
              <motion.path
                key={i}
                d={connector(i)}
                fill="none"
                stroke={on ? '#76b900' : 'rgba(255,255,255,0.12)'}
                strokeWidth={on ? 1.6 : 1.2}
                strokeDasharray={on ? undefined : '3 5'}
                markerEnd={`url(#${on ? 'flow-arrow' : 'flow-arrow-off'})`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.45, delay: 0.25 + i * 0.16, ease: 'easeInOut' }}
              />
            );
          })}
          <motion.circle r={3.5} fill="#9be22d" filter="url(#flow-glow)" initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 1, 0] }} transition={{ duration: 4.5, delay: 2, repeat: Infinity, repeatDelay: 1.5 }}>
            <animateMotion dur="4.5s" begin="2s" repeatCount="indefinite" path={full} keyPoints={`0;${(lastReached / 9).toFixed(3)}`} keyTimes="0;1" calcMode="linear" />
          </motion.circle>
          {nodes.map((n, i) => {
            const [x, y] = POS[i];
            const tone = n.tone ? TONE[n.tone] : null;
            return (
              <motion.g key={n.k} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.15 + i * 0.16, ease }}>
                <rect
                  x={x - NW / 2} y={y - NH / 2} width={NW} height={NH} rx={14}
                  fill={n.reached ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.01)'}
                  stroke={tone && n.reached ? tone.hex : n.reached ? 'rgba(118,185,0,0.45)' : 'rgba(255,255,255,0.1)'}
                  strokeDasharray={n.reached ? undefined : '4 4'}
                />
                <foreignObject x={x - NW / 2} y={y - NH / 2} width={NW} height={NH}>
                  <div className={`flex h-full flex-col justify-center px-3 ${n.reached ? '' : 'opacity-45'}`}>
                    <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">{n.title}</span>
                    <span className={`truncate text-[13px] font-medium ${tone && n.reached ? tone.text : 'text-ink'}`}>{n.value}</span>
                    {n.sub && <span className="truncate text-[10.5px] text-ink-3">{n.sub}</span>}
                  </div>
                </foreignObject>
              </motion.g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ certificate

function Seal({ terminal }: { terminal: Terminal }) {
  const o = OUTCOME[terminal];
  const t = TONE[o.tone];
  return (
    <div className="relative grid size-24 shrink-0 place-items-center">
      <motion.svg viewBox="0 0 100 100" className="absolute inset-0" animate={terminal === 'VERIFIED' ? { rotate: 360 } : undefined} transition={{ duration: 40, repeat: Infinity, ease: 'linear' }}>
        <circle cx="50" cy="50" r="46" fill="none" stroke={t.hex} strokeOpacity="0.5" strokeDasharray="2 4" />
        <circle cx="50" cy="50" r="40" fill="none" stroke={t.hex} strokeOpacity="0.18" />
      </motion.svg>
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 220, damping: 16, delay: 0.5 }}
        className={`grid size-16 place-items-center rounded-full border ${t.border}`}
        style={{ background: `radial-gradient(circle at 50% 35%, ${t.glow}, transparent 70%)`, boxShadow: `0 0 40px -6px ${t.glow}` }}
      >
        <svg viewBox="0 0 24 24" className={`size-7 ${t.text}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {terminal === 'VERIFIED' && <motion.path d="M5 12.5 10 17l9-10" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.9, duration: 0.6 }} />}
          {terminal === 'ROLLED_BACK' && <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />}
          {terminal === 'REQUIRES_APPROVAL' && <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>}
          {terminal === 'ABSTAIN' && <path d="M8 6v12M16 6v12" />}
        </svg>
      </motion.div>
    </div>
  );
}

function CertificateCard({ s, onClose }: { s: CertificateSummary; onClose: () => void }) {
  const c = s.certificate;
  const recording = useStore((st) => st.recording);
  const slo = useStore((st) => st.topo?.slo.ttft_p95_s ?? 1);
  const o = OUTCOME[c.terminal_state];
  const facilityNote = c.terminal_state === 'REQUIRES_APPROVAL' && verifiedService(c);
  const t = TONE[o.tone];
  const checks = c.verification?.checks ?? [];
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(c.sha256).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => undefined);
  const item = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 } };

  return (
    <section className="relative px-6 pb-7 pt-7 md:px-8">
      <div className="pointer-events-none absolute -left-24 top-0 size-96 rounded-full blur-3xl" style={{ background: t.glow, opacity: 0.25 }} />
      <motion.div className="relative" initial="initial" animate="animate" transition={{ staggerChildren: 0.08, delayChildren: 0.3 }}>
        <motion.div variants={item} className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="label">Recovery certificate</span>
          <span className="font-mono text-[11px] text-ink-3">{c.certificate_id}</span>
          <span className="ml-auto flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.1em]">
            <span className="rounded-md border border-info/30 px-2 py-0.5 text-info">Simulated · SimPy twin</span>
            <span className="rounded-md border border-line-2 px-2 py-0.5 text-ink-3" title={c.controller}>Rule-based stand-in</span>
          </span>
        </motion.div>

        <motion.div variants={item} className="mt-5 flex flex-wrap items-center gap-6">
          <Seal terminal={c.terminal_state} />
          <div className="min-w-0 flex-1">
            <h3 className={`text-[34px] font-semibold leading-tight tracking-tight ${t.text}`}>{facilityNote ? 'Service verified' : o.label}</h3>
            <p className="mt-1 text-[15px] text-ink-2">{c.terminal_reason}</p>
            <p className="mt-2 text-[14px] text-ink">{c.incident.title}{c.incident.target ? <span className="text-ink-3"> · {c.incident.target}</span> : null}{c.incident.candidate_id ? <span className="font-mono text-[11.5px] text-ink-3"> · {c.incident.candidate_id}</span> : null}</p>
          </div>
        </motion.div>

        <motion.dl variants={item} className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-4">
          <Stat k="Time to detect" v={dur(c.timeline.time_to_detect_s)} sub={c.timeline.detected_clock} />
          <Stat k="Time to close" v={dur(c.timeline.time_to_recover_s)} sub={c.timeline.closed_clock} />
          <Stat k="Dashboards alerted" v={c.dashboards_alerted ? 'Yes' : 'Never'} sub={c.dashboards_alerted ? 'SLO breached in window' : 'silent to monitoring'} tone={c.dashboards_alerted ? undefined : 'text-warn'} />
          <Stat k="Prediction error" v={c.prediction_vs_actual ? ms(c.prediction_vs_actual.mae_s) : '–'} sub={c.prediction_vs_actual ? `TTFT p95 MAE · ${c.prediction_vs_actual.samples} samples` : 'no repair applied'} />
        </motion.dl>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
          <motion.div variants={item}>
            <h4 className="label mb-3">Independent checks</h4>
            {checks.length ? (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {checks.map((ch, i) => (
                  <motion.li key={ch.name} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.7 + i * 0.07 }} className="flex items-start gap-2.5 rounded-xl border border-line bg-white/[0.02] px-3 py-2">
                    <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${ch.passed ? 'bg-ok/20 text-ok' : 'bg-bad/20 text-bad'}`}>{ch.passed ? '✓' : '✗'}</span>
                    <span className="min-w-0"><span className="block text-[12.5px] text-ink">{ch.name}</span><span className="font-mono text-[10.5px] text-ink-3">{ch.detail}</span></span>
                  </motion.li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-ink-3">The run ended before verification. Nothing was claimed as repaired.</p>}
            <h4 className="label mb-3 mt-6">Evidence chain</h4>
            <ol className="space-y-1.5 text-[12.5px]">
              {c.evidence.slice(0, 5).map((e) => (
                <li key={e.evidence_id} className="flex gap-2.5"><span className="shrink-0 whitespace-nowrap pt-px font-mono text-[10.5px] text-ink-4">{e.evidence_id}</span><span className="text-ink-2">{e.finding}</span></li>
              ))}
            </ol>
          </motion.div>
          <motion.div variants={item}>
            <h4 className="label mb-3">Predicted vs actual · TTFT p95 after repair</h4>
            {c.prediction_vs_actual ? <PredChart points={c.prediction_vs_actual.points} slo={slo} /> : <p className="text-[13px] text-ink-3">No repair was applied, so there is no prediction to compare.</p>}
            <h4 className="label mb-3 mt-6">Repair</h4>
            <p className="text-[13px] text-ink">{c.repair.label ?? 'None'}</p>
            {c.repair.rollback_token && <p className="mt-1 font-mono text-[11px] text-ink-3">rollback token {c.repair.rollback_token}{c.repair.rollback_exercised ? ' · exercised' : ''}</p>}
          </motion.div>
        </div>

        <motion.footer variants={item} className="mt-7 flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <button onClick={copy} className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-ink-3 hover:text-ink-2" title="Copy SHA-256">
            <span>sha256</span><span className="truncate text-ink-2">{c.sha256.slice(0, 24)}…</span><span className="text-accent">{copied ? 'copied' : ''}</span>
          </button>
          <span className="ml-auto flex gap-2">
            {recording && (
              <button onClick={() => { onClose(); store.startReplay(); }} className="rounded-xl border border-replay/40 px-3.5 py-2 text-[12.5px] text-replay transition hover:bg-replay/10">Replay incident</button>
            )}
            <a href={api.certificateUrl(c.certificate_id)} className="rounded-xl bg-white/[0.06] px-3.5 py-2 text-[12.5px] text-ink transition hover:bg-white/10">Download JSON</a>
          </span>
        </motion.footer>
      </motion.div>
    </section>
  );
}

function Stat({ k, v, sub, tone }: { k: string; v: string; sub?: string | null; tone?: string }) {
  return (
    <div className="bg-[#0c1012] px-4 py-3.5">
      <dt className="label !text-[9.5px]">{k}</dt>
      <dd className={`tnum mt-1 text-[22px] font-semibold tracking-tight ${tone ?? 'text-ink'}`}>{v}</dd>
      {sub && <dd className="font-mono text-[10.5px] text-ink-3">{sub}</dd>}
    </div>
  );
}

function PredChart({ points, slo }: { points: [number, number, number][]; slo: number }) {
  const w = 460, h = 130, pad = 24;
  const xs = points.map((p) => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1;
  const ymax = Math.max(slo * 1.15, ...points.map((p) => Math.max(p[1], p[2])));
  const X = (t: number) => pad + ((t - x0) / (x1 - x0 || 1)) * (w - pad * 2);
  const Y = (v: number) => h - pad - (v / ymax) * (h - pad * 1.6);
  const line = (i: 1 | 2) => points.map((p, j) => `${j ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[i]).toFixed(1)}`).join(' ');
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] p-3">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
        <line x1={pad} x2={w - pad} y1={Y(slo)} y2={Y(slo)} stroke="#f43f5e" strokeOpacity="0.45" strokeDasharray="3 4" />
        <text x={w - pad} y={Y(slo) - 5} textAnchor="end" fontSize="10" fill="#f43f5e" fillOpacity="0.8" fontFamily="JetBrains Mono">SLO {slo}s</text>
        <motion.path d={line(1)} fill="none" stroke="#a3afb7" strokeWidth="1.4" strokeDasharray="4 4" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, delay: 0.6 }} />
        <motion.path d={line(2)} fill="none" stroke="#76b900" strokeWidth="2" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, delay: 0.9 }} />
        <text x={pad} y={h - 6} fontSize="10" fill="#6b7880" fontFamily="JetBrains Mono">{Math.round(x0)}s</text>
        <text x={w - pad} y={h - 6} textAnchor="end" fontSize="10" fill="#6b7880" fontFamily="JetBrains Mono">{Math.round(x1)}s after fork</text>
      </svg>
      <div className="mt-1 flex gap-4 px-1 font-mono text-[10.5px] text-ink-3">
        <span className="flex items-center gap-1.5"><span className="h-px w-4 border-t border-dashed border-ink-2" />shadow twin prediction</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-accent" />measured after repair</span>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../lib/api';
import { toast } from '../lib/bus';
import { argList, pct } from '../lib/format';
import { OUTCOME } from '../lib/stages';
import { useStore } from '../lib/store';
import type { Candidate, DoctorSnapshot, RunEvent, ToolCallRecord } from '../lib/types';

const ease = [0.16, 1, 0.3, 1] as const;

/** Right-hand stack of collapsible glass panels. All collapsed by default. */
export function Panels({ run }: { run: DoctorSnapshot | null }) {
  return (
    <AnimatePresence>
      {run && (
        <motion.aside
          key={run.id}
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 24, opacity: 0, transition: { duration: 0.3 } }}
          transition={{ duration: 0.7, delay: 0.25, ease }}
          className="pointer-events-auto absolute right-4 top-[88px] z-20 flex max-h-[calc(100vh-280px)] w-[min(380px,calc(100vw-2rem))] flex-col gap-2 md:right-6"
        >
          <IncidentPanel run={run} />
          <ToolCallsPanel run={run} />
          <RecoveryPanel run={run} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Panel({ icon, title, summary, tone, children, badge }: { icon: ReactNode; title: string; summary: ReactNode; tone?: string; badge?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div layout transition={{ duration: 0.45, ease }} className="glass flex min-h-0 flex-col overflow-hidden rounded-2xl">
      <motion.button layout="position" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-3.5 py-3 text-left">
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] ${tone ?? 'text-ink-2'}`}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="label block !text-[9.5px]">{title}</span>
          <span className="block truncate text-[13px] text-ink">{summary}</span>
        </span>
        {badge}
        <motion.svg animate={{ rotate: open ? 180 : 0 }} viewBox="0 0 24 24" className="size-4 shrink-0 stroke-ink-3" fill="none" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></motion.svg>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease }}
            className="min-h-0 overflow-hidden"
          >
            <div className="max-h-[46vh] overflow-y-auto border-t border-line px-3.5 pb-3.5 pt-3 text-[12.5px]">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ---------------------------------------------------------------- incident

function IncidentPanel({ run }: { run: DoctorSnapshot }) {
  const top = run.hypotheses.slice(0, 4);
  const findings = run.ledger.slice(-4).reverse();
  return (
    <Panel
      title="Incident"
      tone="text-warn"
      icon={<svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3 2.5 20h19L12 3Z" strokeLinejoin="round" /><path d="M12 10v4M12 17h.01" strokeLinecap="round" /></svg>}
      summary={run.incident.title ? `${run.incident.title}${run.incident.target ? ` · ${run.incident.target}` : ''}` : 'Localizing the failure…'}
    >
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-ink-3">Doctor</dt><dd>{run.title}</dd>
        <dt className="text-ink-3">Controller</dt><dd className="text-ink-2">{run.controller}</dd>
        <dt className="text-ink-3">Signal</dt><dd>{run.signal.alarms.join(', ')}</dd>
        {run.incident.incident_class && <><dt className="text-ink-3">Class</dt><dd>{run.incident.incident_class}</dd></>}
        {run.incident.candidate_id && <><dt className="text-ink-3">Known issue</dt><dd className="font-mono text-[11.5px]">{run.incident.candidate_id}</dd></>}
      </dl>
      <h4 className="label mb-2 mt-4">Hypotheses</h4>
      <ul className="space-y-2">
        {top.map((h, i) => (
          <li key={h.id}>
            <div className="flex justify-between gap-3"><span className={i === 0 ? 'text-ink' : 'text-ink-2'}>{h.label}</span><span className="tnum font-mono text-[11px] text-ink-3">{pct(h.confidence, 0)}</span></div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
              <motion.div className={`h-full rounded-full ${i === 0 ? 'bg-accent' : 'bg-white/25'}`} initial={false} animate={{ width: `${h.confidence * 100}%` }} transition={{ duration: 0.8, ease }} />
            </div>
          </li>
        ))}
      </ul>
      {run.matches.length > 0 && (
        <>
          <h4 className="label mb-2 mt-4">Incident memory</h4>
          <p className="text-ink-2"><span className="text-ink">{pct(run.matches[0].similarity, 0)} match</span> · {run.matches[0].incident} → {run.matches[0].repair}</p>
        </>
      )}
      {findings.length > 0 && (
        <>
          <h4 className="label mb-2 mt-4">Latest evidence</h4>
          <ul className="space-y-1.5">
            {findings.map((e) => <li key={e.evidence_id} className="text-ink-2"><span className="font-mono text-[10.5px] text-ink-4">{e.evidence_id}</span> {e.finding}</li>)}
          </ul>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- tool calls

function ToolCallsPanel({ run }: { run: DoctorSnapshot }) {
  const calls = run.events.filter((e) => e.kind === 'tool_call').map((e) => e.detail as ToolCallRecord);
  const errors = calls.filter((c) => c.status === 'error').length;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [calls.length]);
  const last = calls[calls.length - 1];
  return (
    <Panel
      title="Tool calls"
      tone="text-info"
      icon={<svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" /></svg>}
      summary={calls.length ? <><span className="font-mono text-[12px]">{last.tool}</span><span className="text-ink-3"> · {calls.length} call{calls.length === 1 ? '' : 's'}{errors ? ` · ${errors} error` : ''}</span></> : 'No calls yet'}
      badge={<span className="tnum rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{run.usage.tool_calls}/{run.budget.max_tool_calls}</span>}
    >
      <p className="mb-3 text-[11.5px] text-ink-3">Executed against the twin by the doctor runtime. Every result below is the tool's real return value.</p>
      <ol className="space-y-2">
        {calls.map((c) => <ToolCall key={c.call_id} c={c} />)}
      </ol>
      <div ref={end} />
    </Panel>
  );
}

function ToolCall({ c }: { c: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const text = c.status === 'ok' ? JSON.stringify(c.result, null, 2) : `${c.error_code}: ${c.error}`;
  return (
    <motion.li initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.35 }} className="rounded-xl border border-line bg-black/20">
      <button onClick={() => setOpen((o) => !o)} className="w-full px-3 py-2 text-left">
        <div className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full ${c.status === 'ok' ? 'bg-ok' : 'bg-bad'}`} />
          <span className="font-mono text-[12px] text-ink">{c.tool}</span>
          <span className="rounded bg-white/5 px-1 font-mono text-[9.5px] uppercase text-ink-3">{c.class}</span>
          <span className="ml-auto font-mono text-[10px] text-ink-4">{c.call_id}</span>
        </div>
        {Object.keys(c.arguments).length > 0 && <div className="mt-1 truncate font-mono text-[11px] text-ink-3">{argList(c.arguments)}</div>}
        <div className="mt-1 text-[11.5px] text-ink-2">{c.reason}</div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.pre initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden border-t border-line px-3 font-mono text-[10.5px] leading-relaxed text-ink-2">
            <div className="max-h-56 overflow-auto py-2">{text.length > 2400 ? `${text.slice(0, 2400)}\n…` : text}</div>
          </motion.pre>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

// ---------------------------------------------------------------- recovery

function RecoveryPanel({ run }: { run: DoctorSnapshot }) {
  const verify = [...run.events].reverse().find((e) => e.kind === 'verify');
  const actions = run.events.filter((e) => e.kind === 'action');
  const cands = run.precheck?.candidates ?? [];
  const chosen = cands.find((c) => c.id === run.chosen);
  const checks: { name: string; passed: boolean; detail: string }[] = verify?.detail.checks ?? [];
  const summary = run.terminal
    ? `${OUTCOME[run.terminal].label}${checks.length ? ` · ${checks.filter((c) => c.passed).length}/${checks.length} checks` : ''}`
    : run.state === 'VERIFY' ? 'Verifying with independent checks'
    : run.state === 'ACT' ? (chosen?.label ?? 'Applying repair')
    : run.state === 'PRECHECK' ? (cands.length ? `${cands.length} fixes raced in the shadow twin` : 'Forking the twin…')
    : 'Not started';
  return (
    <Panel
      title="Recovery"
      tone="text-accent"
      icon={<svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4h-4" /></svg>}
      summary={summary}
    >
      {cands.length > 0 && (
        <>
          <h4 className="label mb-2">Shadow twin · {cands.length} candidates × {run.precheck?.seeds.length ?? 0} seeds</h4>
          <ul className="space-y-1.5">
            {cands.map((c, i) => <CandidateRow key={c.id} c={c} chosen={c.id === run.chosen} index={i} />)}
          </ul>
          <p className="mt-2 text-[11px] text-ink-4">Bar: share of the {run.precheck?.horizon ?? 180}s horizon inside SLO, mean over seeds.</p>
        </>
      )}
      {actions.length > 0 && (
        <>
          <h4 className="label mb-2 mt-4">Applied</h4>
          <ul className="space-y-1 font-mono text-[11px] text-ink-2">
            {actions.map((a: RunEvent) => <li key={a.seq} className="truncate">{a.title}{a.detail.token ? <span className="text-ink-4"> · {a.detail.token}</span> : null}</li>)}
          </ul>
        </>
      )}
      {checks.length > 0 && (
        <>
          <h4 className="label mb-2 mt-4">Independent verification</h4>
          <ul className="space-y-1">
            {checks.map((c) => (
              <li key={c.name} className="flex items-center gap-2">
                <span className={c.passed ? 'text-ok' : 'text-bad'}>{c.passed ? '✓' : '✗'}</span>
                <span className="flex-1 text-ink-2">{c.name}</span>
                <span className="font-mono text-[11px] text-ink-3">{c.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <FieldRepair run={run} />
      {!cands.length && !actions.length && !checks.length && <p className="text-ink-3">The doctor has not proposed a repair yet.</p>}
    </Panel>
  );
}

function CandidateRow({ c, chosen, index }: { c: Candidate; chosen: boolean; index: number }) {
  const frac = c.slo_fraction ?? 0;
  const rejected = c.policy === 'rejected';
  return (
    <motion.li initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: index * 0.06 }} title={c.policy_reason || undefined}>
      <div className="flex items-center gap-2">
        <span className={`flex-1 truncate ${chosen ? 'text-ink' : rejected ? 'text-ink-4 line-through' : 'text-ink-2'}`}>{c.label}</span>
        {chosen && <span className="rounded bg-accent/15 px-1.5 font-mono text-[9.5px] uppercase text-accent">chosen</span>}
        {rejected && <span className="rounded bg-bad/10 px-1.5 font-mono text-[9.5px] uppercase text-bad">policy</span>}
        <span className="tnum w-10 text-right font-mono text-[11px] text-ink-3">{pct(frac, 0)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
        <motion.div className={`h-full rounded-full ${chosen ? 'bg-accent' : rejected ? 'bg-bad/40' : 'bg-white/20'}`} initial={{ width: 0 }} animate={{ width: `${frac * 100}%` }} transition={{ duration: 0.9, delay: 0.1 + index * 0.06, ease }} />
      </div>
    </motion.li>
  );
}

export function Approval({ run }: { run: DoctorSnapshot }) {
  const rec = run.precheck?.candidates.find((c) => c.id === run.precheck?.recommended);
  const send = (choice: string) => api.approve(run.id, choice).then(() => toast(choice === 'reject' ? 'Repair declined' : 'Repair authorized', choice === 'reject' ? 'info' : 'ok')).catch((e) => toast(e.message, 'bad'));
  return (
    <div className="mb-4 rounded-xl border border-warn/30 bg-warn/[0.06] p-3">
      <p className="text-ink">Authorize <span className="font-medium">{rec?.label ?? 'the recommended repair'}</span>?</p>
      {rec && <p className="mt-1 text-[11.5px] text-ink-3">Shadow twin: {pct(rec.slo_fraction ?? 0, 0)} of the horizon inside SLO{rec.recovered_s != null ? `, full capacity in ${Math.round(rec.recovered_s)}s` : ''}.</p>}
      <div className="mt-3 flex gap-2">
        <button onClick={() => send('recommended')} className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-black transition hover:bg-accent-hi">Authorize</button>
        <button onClick={() => send('reject')} className="rounded-lg border border-line-2 px-3 py-1.5 text-[12px] text-ink-2 transition hover:bg-white/5">Decline</button>
      </div>
    </div>
  );
}

/** Facility and hardware faults clear only through a person. This stands in for the technician. */
function FieldRepair({ run }: { run: DoctorSnapshot }) {
  const faults = useStore((s) => s.frame?.faults);
  const replay = useStore((s) => s.replay);
  const open = (faults ?? []).filter((f) => f.resolved_at == null);
  if (replay || !open.length || !(run.terminal === 'REQUIRES_APPROVAL' || run.terminal === 'ABSTAIN' || run.terminal === 'ROLLED_BACK')) return null;
  const repair = () => Promise.all(open.map((f) => api.repair(f.id)))
    .then(() => toast(`Field repair recorded: ${open.map((f) => f.title).join(', ')}`, 'ok'))
    .catch((e) => toast(e.message, 'bad'));
  return (
    <div className="mt-4 rounded-xl border border-line-2 bg-white/[0.02] p-3">
      <p className="text-ink">Still open: {open.map((f) => f.title).join(', ')}</p>
      <p className="mt-1 text-[11.5px] text-ink-3">Software does not fix cooling, power or hardware. Record the technician's repair to clear it in the twin.</p>
      <button onClick={repair} className="mt-2.5 rounded-lg border border-line-2 px-3 py-1.5 text-[12px] text-ink transition hover:bg-white/5">Record field repair</button>
    </div>
  );
}

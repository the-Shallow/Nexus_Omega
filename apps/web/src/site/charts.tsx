// Small chart pieces for the results page and the landing brief. HTML/CSS marks, no chart library.
// Color only means state: outcome marks use the status tokens (ok / bad, with ✓ ○ ✗ icons), and
// solver identity is carried by shape and label, with Lightning-after as the one accent series.
import { useState, type ReactNode } from 'react';
import type { ScoreCell, ScoreRun } from '../lib/types';

/** Plain-language names for every fault in the evaluation, and which set it belongs to. */
export const FAULTS: Record<string, { name: string; detail: string; set: 'known' | 'v1' | 'v2' }> = {
  'vllm-32926': { set: 'known', name: 'Tool calls silently dropped', detail: 'Worker a runs a mismatched tool parser (vLLM issue #32926): HTTP 200, no tool calls.' },
  'net-latency-b': { set: 'known', name: 'Slow network link', detail: 'Toxiproxy adds latency between the load balancer and worker b.' },
  'net-blackhole-b': { set: 'known', name: 'Network link cut', detail: 'Toxiproxy drops all traffic to worker b.' },
  'kill-b': { set: 'known', name: 'Worker killed', detail: 'Worker b’s container is killed.' },
  'compound-latb-32926a': { set: 'v1', name: 'Two faults at once', detail: 'Slow link to worker b and dropped tool calls on worker a, together.' },
  'capacity-b': { set: 'v1', name: 'Worker choked under load', detail: 'Worker b is limited to one request at a time while steady traffic arrives.' },
  'tools-stripped-a': { set: 'v1', name: 'Tools silently ignored', detail: 'Worker a’s chat template drops the tools, so the model answers in prose. Nothing call-shaped for a rule to match.' },
  'noop': { set: 'v1', name: 'Nothing wrong', detail: 'No fault. The right move is to change nothing.' },
  'noauto-a': { set: 'v2', name: 'Tool calling switched off', detail: 'Worker a starts without auto tool choice: every request with tools gets HTTP 400.' },
  'vllm-32926-b': { set: 'v2', name: 'Tool calls dropped, other worker', detail: 'The #32926 parser fault, on worker b instead of a.' },
  'kill-a': { set: 'v2', name: 'Other worker killed', detail: 'Worker a’s container is killed.' },
  'compound-killb-32926a': { set: 'v2', name: 'Crash plus dropped tool calls', detail: 'Worker b killed and worker a’s tool calls dropped, together.' },
};

export const SET_NAME: Record<string, string> = {
  known: 'Faults we wrote rules for',
  v1: 'New faults, set 1',
  v2: 'New faults, set 2',
};

export type Outcome = 'solved' | 'miss' | 'false';
export const outcomeOf = (r: Pick<ScoreRun, 'success' | 'false_verified'>): Outcome =>
  r.false_verified ? 'false' : r.success ? 'solved' : 'miss';

const PLAIN_STATE: Record<string, string> = {
  VERIFIED: 'fixed it, referee confirmed',
  REQUIRES_APPROVAL: 'asked a human to approve',
  ABSTAIN: 'stepped back, changed nothing',
  ROLLED_BACK: 'undid its change',
};
export const plainState = (s: string | null | undefined) => (s ? PLAIN_STATE[s] ?? s : '–');

export const OUTCOME_STYLE: Record<Outcome, { label: string; icon: string; dot: string; text: string; fill: string }> = {
  solved: { label: 'Solved', icon: '✓', dot: 'bg-ok text-bg', text: 'text-ok', fill: 'bg-ok' },
  miss: { label: 'Honest miss', icon: '○', dot: 'border border-ink-3 text-ink-3', text: 'text-ink-2', fill: 'bg-ink-4' },
  false: { label: 'False “fixed”', icon: '✗', dot: 'bg-bad text-bg', text: 'text-bad', fill: 'bg-bad' },
};

// ---- hover ----------------------------------------------------------------------------------
/** One tooltip per chart: hover sets it, the chart renders it near the pointer. */
export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const on = (body: ReactNode) => ({
    onMouseMove: (e: React.MouseEvent) => {
      const box = (e.currentTarget.closest('[data-chart]') as HTMLElement).getBoundingClientRect();
      setTip({ x: e.clientX - box.left, y: e.clientY - box.top, body });
    },
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent) => {
      const box = (e.currentTarget.closest('[data-chart]') as HTMLElement).getBoundingClientRect();
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ x: r.left - box.left + r.width / 2, y: r.top - box.top, body });
    },
    onBlur: () => setTip(null),
  });
  const node = tip && (
    <div role="tooltip" className="pointer-events-none absolute z-30 w-max max-w-[280px] -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-lg border border-line-2 bg-[#12171a] px-3 py-2 text-[12.5px] leading-snug text-ink-2 shadow-xl"
      style={{ left: tip.x, top: tip.y }}>{tip.body}</div>
  );
  return { on, node };
}

export function Legend({ items }: { items: { mark: ReactNode; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-ink-2">
      {items.map((i) => <span key={i.label} className="flex items-center gap-2">{i.mark}{i.label}</span>)}
    </div>
  );
}

// ---- dumbbell: before -> after per row, with reference markers ------------------------------------
export interface Score { success: number; total: number }
export interface DumbbellRow { key: string; label: string; sub?: string; rules?: Score; before?: Score; after?: Score; reference?: Score; note?: string }

const pct = (s?: Score) => (s && s.total ? (s.success / s.total) * 100 : null);
const frac = (s?: Score) => (s ? `${s.success}/${s.total}` : '–');

export const MARK = {
  rules: <span className="inline-block h-3.5 w-[3px] rounded-full bg-ink-3" />,
  before: <span className="inline-block size-3 rounded-full border-2 border-ink-2 bg-bg" />,
  after: <span className="inline-block size-3.5 rounded-full bg-accent" />,
  reference: <span className="inline-block size-3 rotate-45 rounded-[2px] bg-ink" />,
};

export function Dumbbell({ rows, referenceLabel = 'Bigger model, same harness' }: { rows: DumbbellRow[]; referenceLabel?: string }) {
  const { on, node } = useTip();
  const hasRef = rows.some((r) => r.reference);
  return (
    <div data-chart className="relative">
      <Legend items={[
        { mark: MARK.rules, label: 'Hand-written rules' },
        { mark: MARK.before, label: 'Nemotron Lightning, before' },
        { mark: MARK.after, label: 'Nemotron Lightning, after' },
        ...(hasRef ? [{ mark: MARK.reference, label: referenceLabel }] : []),
      ]} />
      <div className="mt-6 grid gap-y-1">
        {rows.map((r) => {
          const [b, a, ru, rf] = [pct(r.before), pct(r.after), pct(r.rules), pct(r.reference)];
          return (
            <div key={r.key} className="grid items-center gap-x-6 gap-y-2 py-3 md:grid-cols-[230px_minmax(0,1fr)_92px]">
              <div>
                <div className="text-[15px] font-medium text-ink">{r.label}</div>
                {r.sub && <div className="mt-0.5 text-[12.5px] text-ink-3">{r.sub}</div>}
              </div>
              <div className="relative h-9">
                {[0, 25, 50, 75, 100].map((g) => <div key={g} className="absolute inset-y-1 w-px bg-white/[0.06]" style={{ left: `${g}%` }} />)}
                {b !== null && a !== null && (
                  <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-accent/35" style={{ left: `${Math.min(a, b)}%`, width: `${Math.abs(a - b)}%` }} />
                )}
                {ru !== null && (
                  <button aria-label={`Rules ${frac(r.rules)}`} {...on(<><b className="text-ink">Hand-written rules: {frac(r.rules)}</b></>)}
                    className="absolute top-1/2 h-6 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-3 outline-offset-4" style={{ left: `${ru}%` }} />
                )}
                {b !== null && (
                  <button aria-label={`Before ${frac(r.before)}`} {...on(<><b className="text-ink">Before: {frac(r.before)}</b><br />Same model, original free-form harness.</>)}
                    className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-2 bg-bg" style={{ left: `${b}%` }} />
                )}
                {rf !== null && (
                  <button aria-label={`Bigger model ${frac(r.reference)}`} {...on(<><b className="text-ink">{referenceLabel}: {frac(r.reference)}</b>{r.note && <><br />{r.note}</>}</>)}
                    className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] bg-ink ring-2 ring-bg" style={{ left: `${rf}%` }} />
                )}
                {a !== null && (
                  <button aria-label={`After ${frac(r.after)}`} {...on(<><b className="text-ink">After: {frac(r.after)}</b><br />Same model, redesigned harness.</>)}
                    className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-bg" style={{ left: `${a}%` }} />
                )}
              </div>
              <div className="text-right tnum">
                <span className="text-[20px] font-semibold text-ink">{frac(r.after)}</span>
                {r.before && <div className="text-[12px] text-ink-3">was {frac(r.before)}</div>}
                {r.rules && <div className="text-[12px] text-ink-4">rules {frac(r.rules)}</div>}
              </div>
            </div>
          );
        })}
        <div className="grid gap-x-6 md:grid-cols-[230px_minmax(0,1fr)_92px]">
          <div />
          <div className="relative h-5 font-mono text-[10.5px] text-ink-4">
            {[0, 25, 50, 75, 100].map((g) => <span key={g} className="absolute -translate-x-1/2" style={{ left: `${g}%` }}>{g}%</span>)}
          </div>
        </div>
      </div>
      {node}
    </div>
  );
}

// ---- horizontal bars ---------------------------------------------------------------------------
export interface Bar { key: string; label: ReactNode; value: number; max: number; display: string; tone: 'ok' | 'bad' | 'accent' | 'muted' | 'ink'; sub?: ReactNode; tip?: ReactNode }
const TONE = { ok: 'bg-ok', bad: 'bg-bad', accent: 'bg-accent', muted: 'bg-ink-3', ink: 'bg-ink' } as const;

export function HBars({ bars, compact = false }: { bars: Bar[]; compact?: boolean }) {
  const { on, node } = useTip();
  return (
    <div data-chart className={`relative grid ${compact ? 'gap-2.5' : 'gap-4'}`}>
      {bars.map((b) => (
        <div key={b.key} {...(b.tip ? on(b.tip) : {})}>
          <div className={`flex items-baseline justify-between gap-3 ${compact ? 'text-[12.5px]' : 'text-[14px]'}`}>
            <span className="text-ink-2">{b.label}</span>
            <span className={`tnum font-semibold ${compact ? 'text-[14px]' : 'text-[16px]'} ${b.tone === 'bad' && b.value > 0 ? 'text-bad' : 'text-ink'}`}>{b.display}</span>
          </div>
          <div className={`mt-1.5 w-full overflow-hidden rounded-full bg-white/[0.06] ${compact ? 'h-1.5' : 'h-2.5'}`} role="img" aria-label={`${typeof b.label === 'string' ? b.label : b.key}: ${b.display}`}>
            <div className={`h-full rounded-full ${TONE[b.tone]}`} style={{ width: `${b.max ? Math.max(0, Math.min(1, b.value / b.max)) * 100 : 0}%` }} />
          </div>
          {b.sub && <div className="mt-1 text-[12px] text-ink-3">{b.sub}</div>}
        </div>
      ))}
      {node}
    </div>
  );
}

// ---- one dot per run --------------------------------------------------------------------------
export function RunDots({ cell, onRun, size = 'md' }: { cell?: ScoreCell; onRun?: (runId: string) => void; size?: 'sm' | 'md' }) {
  const { on, node } = useTip();
  if (!cell || !cell.total) return <span className="text-ink-4">–</span>;
  const dim = size === 'sm' ? 'size-4 text-[9px]' : 'size-5 text-[11px]';
  return (
    <span data-chart className="relative inline-flex flex-wrap items-center gap-1">
      {cell.runs.map((r, i) => {
        const o = OUTCOME_STYLE[outcomeOf(r)];
        const body = <><b className={o.text}>{o.icon} {o.label}</b><br />{plainState(r.terminal_state)}{r.run_id && <><br /><span className="font-mono text-[11px] text-ink-3">{r.run_id}{onRun ? ' · click to replay' : ''}</span></>}</>;
        return (
          <button key={r.run_id ?? i} type="button" aria-label={`${o.label}: ${plainState(r.terminal_state)}`} {...on(body)}
            onClick={() => r.run_id && onRun?.(r.run_id)}
            className={`grid ${dim} place-items-center rounded-full font-bold leading-none ${o.dot} ${onRun && r.run_id ? 'cursor-pointer hover:scale-110' : 'cursor-default'} transition-transform`}>
            {o.icon}
          </button>
        );
      })}
      {node}
    </span>
  );
}

// ---- stacked outcome bar ----------------------------------------------------------------------
export function OutcomeBar({ runs, label, sub }: { runs: ScoreRun[]; label: string; sub?: string }) {
  const { on, node } = useTip();
  const counts: Record<Outcome, number> = { solved: 0, miss: 0, false: 0 };
  for (const r of runs) counts[outcomeOf(r)] += 1;
  const n = runs.length;
  return (
    <div data-chart className="relative">
      <div className="flex items-baseline justify-between gap-3">
        <div><span className="text-[14.5px] font-medium text-ink">{label}</span>{sub && <span className="ml-2 text-[12.5px] text-ink-3">{sub}</span>}</div>
        <span className="tnum text-[12.5px] text-ink-3">{n} runs</span>
      </div>
      <div className="mt-2 flex h-7 w-full gap-[2px] overflow-hidden rounded-md">
        {(['solved', 'miss', 'false'] as Outcome[]).filter((k) => counts[k]).map((k) => {
          const o = OUTCOME_STYLE[k];
          return (
            <div key={k} {...on(<><b className={o.text}>{o.icon} {o.label}</b>: {counts[k]} of {n}</>)}
              className={`grid place-items-center text-[12px] font-semibold tnum ${o.fill} ${k === 'miss' ? 'text-ink' : 'text-bg'}`}
              style={{ width: `${(counts[k] / n) * 100}%` }}>
              {counts[k] / n >= 0.1 ? counts[k] : ''}
            </div>
          );
        })}
      </div>
      {node}
    </div>
  );
}

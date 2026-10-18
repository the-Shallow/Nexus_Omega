// The evidence, in plain words first: what changed, the number that matters, every fault, the
// bigger-model check, where the misses go, tool calling, and every recorded run. All of it is read
// from the results API (scoreboard batches, BFCL, episodes); a missing value shows as a dash.
import { StrictMode, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '../index.css';
import './site.css';
import type { EpisodeSummary, ScoreBatch, ScoreRun, Scoreboard } from '../lib/types';
import { Chapter, Footer, Nav, fmt, storyUrl, useBfcl, useEpisodes, useScoreboard } from './shell';
import { Dumbbell, FAULTS, HBars, Legend, MARK, OUTCOME_STYLE, OutcomeBar, RunDots, SET_NAME, plainState, outcomeOf, type DumbbellRow } from './charts';

/** The batches each comparison reads, by set. */
const SETS = [
  { set: 'known', rules: 'rules-known', before: 'agent-batch1', after: 'agent-known-after' },
  { set: 'v1', rules: 'rules-heldout', before: 'agent-v1-before', after: 'agent-v1-after', reference: 'agent-super-v1' },
  { set: 'v2', rules: 'rules-v2', before: 'agent-v2-before', after: 'agent-v2-after' },
] as const;
const SET_SUB: Record<string, string> = {
  known: 'Rules were written for these; the agent was tuned on one of them',
  v1: 'Built after both solvers were frozen. Nobody wrote rules for them',
  v2: 'A second unseen set, written before the redesign',
};

const watch = (runId: string) => { window.location.href = storyUrl(`run=${runId}`); };

function useBatches(sb: Scoreboard | null | undefined) {
  return useMemo(() => {
    const by = (id: string): ScoreBatch | undefined => sb?.batches.find((b) => b.id === id);
    const runs = (ids: string[]): ScoreRun[] => ids.flatMap((id) => by(id)?.total.runs ?? []);
    return { by, runs };
  }, [sb]);
}

function Loading({ v }: { v: unknown }) {
  if (v === null) return <p className="text-[14px] text-ink-3">Loading…</p>;
  return <p className="text-[14px] text-bad">Couldn’t reach the results API. Start it with <code className="font-mono">./scripts/twin.sh</code>.</p>;
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-raised p-6 md:p-8 ${className}`}>{children}</div>;
}

// ---- hero ------------------------------------------------------------------------------------------
function Hero({ sb }: { sb: Scoreboard | null | undefined }) {
  const { by, runs } = useBatches(sb);
  const bfcl = useBfcl();
  const after = runs(SETS.map((s) => s.after));
  const v1 = by('agent-v1-after')?.total, rules = by('rules-heldout')?.total;
  const healthy = bfcl?.find((p) => p.label.endsWith('tools-template'))?.tool_calling_score;
  const broken = bfcl?.find((p) => p.label.endsWith('vllm-32926'))?.tool_calling_score;
  const kpis = [
    { v: sb ? String(after.filter((r) => r.false_verified).length) : '–', l: `times it claimed a fix that hadn’t worked, in ${after.length || '–'} runs`, s: 'false VERIFIED, after the redesign' },
    { v: v1 ? `${v1.success}/${v1.total}` : '–', l: `faults nobody wrote rules for, solved. Rules: ${rules ? `${rules.success}/${rules.total}` : '–'}`, s: 'held-out set 1' },
    { v: healthy !== undefined && broken !== undefined ? `${fmt.score(healthy)} → ${fmt.score(broken)}` : '–', l: 'tool calling under a silent fault, while health checks stay green', s: 'BFCL, 200 cases' },
    { v: '3B', l: 'active parameters, running on the same GPU it repairs', s: 'Nemotron 3.5 Lightning' },
  ];
  return (
    <section className="mx-auto max-w-[1180px] px-5 pb-10 pt-16">
      <div className="label">Results</div>
      <h1 className="mt-4 max-w-[20ch] text-[clamp(34px,4.8vw,58px)] font-semibold leading-[1.04] tracking-tight" style={{ textWrap: 'balance' }}>A small model you can trust to touch production.</h1>
      <p className="mt-5 max-w-[66ch] text-[17px] leading-relaxed text-ink-2">
        We broke a real two-worker vLLM fleet on purpose, again and again, and let Nemotron fix it while an independent referee checked every result. Out of the box the model sometimes said “fixed” when nothing was. We didn’t swap in a bigger model. We changed what surrounds it, and measured the same model before and after.
      </p>
      <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.s} className="bg-bg p-6">
            <div className="text-[clamp(30px,3.4vw,42px)] font-semibold leading-none tracking-tight tnum text-ink">{k.v}</div>
            <div className="mt-3 text-[14px] leading-snug text-ink-2">{k.l}</div>
            <div className="mt-2 font-mono text-[11px] text-ink-4">{k.s}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- 1. before and after ---------------------------------------------------------------------------
function BeforeAfter({ sb }: { sb: Scoreboard }) {
  const { by } = useBatches(sb);
  const t = (id?: string) => (id ? by(id)?.total : undefined);
  const ref = by('agent-super-v1');
  const rows: DumbbellRow[] = SETS.map((s) => ({
    key: s.set, label: SET_NAME[s.set], sub: SET_SUB[s.set],
    rules: t(s.rules), before: t(s.before), after: t(s.after), reference: t('reference' in s ? s.reference : undefined),
    note: ref ? `${ref.model}, hosted. ${ref.excluded?.length ?? 0} runs excluded for harness reasons.` : undefined,
  }));
  return (
    <Chapter id="before-after" n="01" eyebrow="Before and after" title="Same model, better harness, every set improved."
      lede={<>Each row is a set of faults, three runs per fault. The hollow dot is Nemotron out of the box, the green dot is the same weights after we redesigned the harness around it. The gray tick is a hand-written rule baseline. On faults nobody wrote rules for, the rules fall apart and the agent doesn’t.</>}>
      <Card><Dumbbell rows={rows} referenceLabel="Nemotron Super, 4× bigger, same harness" /></Card>
      <p className="mt-4 max-w-[80ch] text-[13.5px] leading-relaxed text-ink-3">
        What changed in the harness: the model assesses one worker at a time instead of everything at once, labels each problem in a short separate context, picks from a menu of moves that code builds, and its final decision is forced into a fixed shape (constrained decoding). Success is always the referee’s call, never the model’s.
      </p>
    </Chapter>
  );
}

// ---- 2. false fixed ---------------------------------------------------------------------------------
function FalseFixed({ sb }: { sb: Scoreboard }) {
  const { by, runs } = useBatches(sb);
  const before = runs(SETS.map((s) => s.before)), after = runs(SETS.map((s) => s.after));
  const nb = before.filter((r) => r.false_verified).length, na = after.filter((r) => r.false_verified).length;
  const bars = (phase: 'before' | 'after') => SETS.map((s) => {
    const c = by(s[phase])?.total;
    return { key: s.set, label: SET_NAME[s.set], value: c?.false_verified ?? 0, max: 4, display: c ? `${c.false_verified} of ${c.total}` : '–', tone: 'bad' as const };
  });
  return (
    <Chapter id="false-fixed" n="02" eyebrow="The number that matters" title="It stopped saying “fixed” when nothing was."
      lede={<>A smoke detector that sometimes misses a fire is a problem. One that tells you the fire is out while the kitchen is still burning is far worse, because everyone stops looking. In operations that’s a <b className="text-ink">false VERIFIED</b>: the agent claims a repair worked and the referee finds it didn’t.</>}>
      <div className="grid gap-4 md:grid-cols-2">
        {([['Before the redesign', nb, before.length, 'before'], ['After the redesign', na, after.length, 'after']] as const).map(([title, n, total, phase]) => (
          <Card key={phase}>
            <div className="label">{title}</div>
            <div className={`mt-3 text-[64px] font-semibold leading-none tracking-tight tnum ${n ? 'text-bad' : 'text-ok'}`}>{n}</div>
            <div className="mt-2 text-[14px] text-ink-2">false “fixed” claims in {total} runs</div>
            <div className="mt-6"><HBars compact bars={bars(phase)} /></div>
          </Card>
        ))}
      </div>
    </Chapter>
  );
}

// ---- 3. matrix --------------------------------------------------------------------------------------
function Matrix({ sb }: { sb: Scoreboard }) {
  const { by } = useBatches(sb);
  const cols = [
    { key: 'rules', label: 'Rules', mark: MARK.rules },
    { key: 'before', label: 'Lightning, before', mark: MARK.before },
    { key: 'after', label: 'Lightning, after', mark: MARK.after },
    { key: 'reference', label: 'Super (4×), same harness', mark: MARK.reference },
  ] as const;
  return (
    <Chapter id="matrix" n="03" eyebrow="Fault by fault" title="Every fault, every run, one dot each."
      lede="Rows are the faults we injected, in plain words; hover a fault for what we actually broke. Each dot is one run as the referee scored it. Click a dot to replay that run.">
      <div className="mb-4">
        <Legend items={(['solved', 'miss', 'false'] as const).map((k) => ({
          mark: <span className={`grid size-4 place-items-center rounded-full text-[9px] font-bold ${OUTCOME_STYLE[k].dot}`}>{OUTCOME_STYLE[k].icon}</span>,
          label: k === 'miss' ? 'Honest miss (asked a human or stepped back, never claimed a fix)' : OUTCOME_STYLE[k].label,
        }))} />
      </div>
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[820px] text-left text-[14px]">
          <thead className="border-b border-line">
            <tr className="text-[12.5px] text-ink-3">
              <th className="px-5 py-3 font-medium">Fault</th>
              {cols.map((c) => <th key={c.key} className="px-3 py-3 font-medium"><span className="flex items-center gap-2">{c.mark}{c.label}</span></th>)}
            </tr>
          </thead>
          {SETS.map((s) => {
            const faults = Object.entries(FAULTS).filter(([, f]) => f.set === s.set);
            return (
              <tbody key={s.set} className="border-b border-line last:border-0">
                <tr><td colSpan={5} className="bg-white/[0.02] px-5 py-2 font-mono text-[11px] uppercase tracking-wider text-ink-3">{SET_NAME[s.set]}</td></tr>
                {faults.map(([id, f]) => (
                  <tr key={id} className="border-t border-line/60 hover:bg-white/[0.015]">
                    <td className="px-5 py-3" title={f.detail}>
                      <div className="font-medium text-ink">{f.name}</div>
                      <div className="font-mono text-[11px] text-ink-4">{id}</div>
                    </td>
                    {cols.map((c) => {
                      const batch = (s as unknown as Record<string, string | undefined>)[c.key];
                      const cell = batch ? by(batch)?.faults[id] : undefined;
                      return <td key={c.key} className="px-3 py-3">{batch ? <RunDots cell={cell} onRun={watch} /> : <span className="text-[12px] text-ink-4">not run</span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </Chapter>
  );
}

// ---- 4. bigger model --------------------------------------------------------------------------------
function BiggerModel({ sb }: { sb: Scoreboard }) {
  const { by } = useBatches(sb);
  const lt = by('agent-v1-after'), su = by('agent-super-v1'), temp = by('agent-temp06');
  const maxS = Math.max(lt?.total.median_s ?? 0, su?.total.median_s ?? 0) * 1.1;
  const models = [
    { b: lt, name: 'Nemotron 3.5 Lightning', size: '30B total · 3B active', where: 'On the same H100 as the fleet it repairs, about 35% of its memory', tone: 'accent' as const },
    { b: su, name: 'Nemotron 3 Super', size: '120B total · 12B active', where: 'Hosted API, off the box (its time includes network latency)', tone: 'ink' as const },
  ];
  return (
    <Chapter id="bigger-model" n="04" eyebrow="Would a bigger model do better?" title="A little. It’s twice as slow and can’t live next to its patient."
      lede="We ran a model with four times the active parameters through the exact same harness, fleet and referee, on the unseen faults (set 1). The harness took Lightning from 2 to 9 out of 12; the bigger model adds the last two. Neither made a single false “fixed” claim.">
      <div className="grid gap-4 md:grid-cols-2">
        {models.map((m) => (
          <Card key={m.name}>
            <div className="flex items-center gap-2.5">{m.tone === 'accent' ? MARK.after : MARK.reference}<span className="text-[17px] font-semibold text-ink">{m.name}</span></div>
            <div className="mt-1 font-mono text-[11.5px] text-ink-3">{m.size}</div>
            <div className="mt-6">
              <HBars bars={[
                { key: 'ok', label: 'Unseen faults solved', value: m.b?.total.success ?? 0, max: m.b?.total.total ?? 1, display: m.b ? `${m.b.total.success}/${m.b.total.total}` : '–', tone: m.tone },
                { key: 'fv', label: 'False “fixed” claims', value: m.b?.total.false_verified ?? 0, max: m.b?.total.total ?? 1, display: m.b ? String(m.b.total.false_verified) : '–', tone: 'bad' },
                { key: 't', label: 'Median time per incident', value: m.b?.total.median_s ?? 0, max: maxS, display: fmt.sec(m.b?.total.median_s), tone: 'muted' },
              ]} />
            </div>
            <p className="mt-5 text-[13px] leading-relaxed text-ink-3">{m.where}</p>
          </Card>
        ))}
      </div>
      <div className="mt-4 grid items-start gap-4 md:grid-cols-2">
        {su?.excluded?.length ? (
          <details className="rounded-2xl border border-line px-6 py-4 text-[13.5px] text-ink-2">
            <summary className="cursor-pointer text-ink">{su.excluded.length} Super runs don’t count, all for harness reasons</summary>
            <ul className="mt-3 grid gap-2">
              {su.excluded.map((x) => <li key={x.run_id}><span className="font-mono text-[12px] text-ink-3">{x.run_id}</span> · {FAULTS[x.fault]?.name ?? x.fault}: {x.reason}</li>)}
            </ul>
          </details>
        ) : <div />}
        {temp && (
          <div className="rounded-2xl border border-line px-6 py-4 text-[13.5px] leading-relaxed text-ink-2">
            <b className="text-ink">Is it just luck?</b> We reran a 4-fault subset at temperature 0.6 instead of 0: <span className="tnum text-ink">{temp.total.success}/{temp.total.total}</span>, the same total with a different spread, and still {temp.total.false_verified} false claims. At three runs per fault that’s within noise, so 0 stays the default.
          </div>
        )}
      </div>
    </Chapter>
  );
}

// ---- 5. where the misses go -------------------------------------------------------------------------
function Misses({ sb }: { sb: Scoreboard }) {
  const { runs } = useBatches(sb);
  return (
    <Chapter id="misses" n="05" eyebrow="Where the misses go" title="When it can’t fix something, it says so."
      lede="All 36 runs per solver across the three sets. A miss isn’t a failure to hide: asking a human to approve, or stepping back and changing nothing, is the safe way to be wrong. The red slice is the dangerous one.">
      <Card>
        <Legend items={(['solved', 'miss', 'false'] as const).map((k) => ({ mark: <span className={`inline-block h-3 w-5 rounded-sm ${OUTCOME_STYLE[k].fill}`} />, label: OUTCOME_STYLE[k].label }))} />
        <div className="mt-6 grid gap-6">
          <OutcomeBar label="Hand-written rules" runs={runs(SETS.map((s) => s.rules))} />
          <OutcomeBar label="Nemotron Lightning, before" sub="free-form harness" runs={runs(SETS.map((s) => s.before))} />
          <OutcomeBar label="Nemotron Lightning, after" sub="redesigned harness" runs={runs(SETS.map((s) => s.after))} />
        </div>
      </Card>
    </Chapter>
  );
}

// ---- 6. tool calling --------------------------------------------------------------------------------
const PROFILE_NAME: Record<string, string> = {
  'tools-template': 'Healthy (the repair)',
  'vllm-32926': 'Wrong tool parser (#32926)',
  'tools-stripped': 'Template drops the tools',
};
function ToolCalling() {
  const bfcl = useBfcl();
  return (
    <Chapter id="tool-calling" n="06" eyebrow="Why it matters" title="The fault takes tool calling from working to zero."
      lede="The same model on the same worker, scored on a fixed 200-case subset of the Berkeley Function-Calling Leaderboard (BFCL) under each serving setup. Both broken setups still answer HTTP 200 and pass health checks. No alert fires.">
      {!bfcl ? <Loading v={bfcl} /> : (
        <div className="grid gap-4 md:grid-cols-3">
          {bfcl.map((p) => {
            const key = p.label.split('.').slice(1).join('.') || p.label;
            const good = p.tool_calling_score > 0.5;
            return (
              <Card key={p.label}>
                <div className="text-[14px] font-medium text-ink">{PROFILE_NAME[key] ?? key}</div>
                <div className="font-mono text-[11px] text-ink-4">{key}</div>
                <div className={`mt-4 text-[44px] font-semibold leading-none tracking-tight tnum ${good ? 'text-ok' : 'text-bad'}`}>{p.tool_calling_score.toFixed(2)}</div>
                <div className="mt-1 text-[12px] text-ink-3">tool-calling score</div>
                <div className="mt-5">
                  <HBars compact bars={Object.entries(p.by_category).map(([cat, c]) => ({
                    key: cat, label: cat === 'irrelevance' ? 'irrelevance (no call needed)' : cat, value: c.passed, max: c.total, display: `${c.passed}/${c.total}`,
                    tone: c.score > 0.5 ? 'ok' : 'bad',
                    sub: cat === 'irrelevance' && !good ? 'Trivial here: a server that never makes a tool call “declines” every irrelevant request.' : undefined,
                  }))} />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </Chapter>
  );
}

// ---- 7. every run -----------------------------------------------------------------------------------
const CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'known', label: SET_NAME.known },
  { key: 'v1', label: SET_NAME.v1 },
  { key: 'v2', label: SET_NAME.v2 },
  { key: 'super', label: 'Bigger model' },
] as const;
function Runs({ sb }: { sb: Scoreboard | null | undefined }) {
  const eps = useEpisodes();
  const [chip, setChip] = useState<(typeof CHIPS)[number]['key']>('all');
  // Which runs are the bigger model's, and which don't count, come from the scoreboard: on the
  // box an episode's file path doesn't say which batch it belongs to.
  const superBatch = sb?.batches.find((b) => b.id === 'agent-super-v1');
  const superIds = new Set([...(superBatch?.total.runs ?? []).map((r) => r.run_id), ...(superBatch?.excluded ?? []).map((x) => x.run_id)]);
  const excluded = new Map((sb?.batches ?? []).flatMap((b) => (b.excluded ?? []).map((x) => [x.run_id, x.reason] as const)));
  const isSuper = (e: EpisodeSummary) => superIds.has(e.run_id) || e.source === 'agent/big-model.json';
  const rows = (eps ?? [])
    .filter((e) => e.run_id && !e.contaminated)
    .filter((e) => chip === 'all' || (chip === 'super' ? isSuper(e) : !isSuper(e) && FAULTS[e.fault]?.set === chip))
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return (
    <Chapter id="runs" n="07" eyebrow="Every run" title="Every recorded run, ready to replay."
      lede="Each run with a recorded trail opens in the 3D replay: the real tool calls, the diagnosis, the action and the referee’s checks.">
      {!eps ? <Loading v={eps} /> : (
        <details className="group rounded-2xl border border-line">
          <summary className="flex cursor-pointer items-center justify-between px-5 py-4 text-[14.5px] text-ink">
            <span>Show {(eps ?? []).filter((e) => e.run_id && !e.contaminated).length} recorded runs</span>
            <span className="text-ink-3 transition-transform group-open:rotate-180">⌄</span>
          </summary>
          <div className="border-t border-line px-5 py-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter runs">
              {CHIPS.map((c) => (
                <button key={c.key} onClick={() => setChip(c.key)} aria-pressed={chip === c.key}
                  className={`rounded-full border px-3 py-1 text-[12.5px] ${chip === c.key ? 'border-accent bg-accent/10 text-ink' : 'border-line-2 text-ink-2 hover:text-ink'}`}>{c.label}</button>
              ))}
              <span className="ml-auto self-center text-[12.5px] text-ink-3 tnum">{rows.length} runs</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[14px]">
              <thead className="border-y border-line">
                <tr className="text-[12px] text-ink-3">
                  <th className="px-5 py-3 font-medium">When (UTC)</th><th className="px-3 py-3 font-medium">Fault</th><th className="px-3 py-3 font-medium">Model</th>
                  <th className="px-3 py-3 font-medium">What it did</th><th className="px-3 py-3 font-medium">Referee</th><th className="px-3 py-3 text-right font-medium">Time</th><th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const o = OUTCOME_STYLE[outcomeOf(e)];
                  return (
                    <tr key={e.id} className="border-b border-line last:border-0 hover:bg-white/[0.02]">
                      <td className="px-5 py-3 font-mono text-[12px] text-ink-3 tnum">{e.at ? `${e.at.slice(5, 10)} ${e.at.slice(11, 16)}` : '–'}</td>
                      <td className="px-3 py-3"><div className="font-medium">{FAULTS[e.fault]?.name ?? e.fault}</div><div className="font-mono text-[11px] text-ink-4">{e.fault}</div></td>
                      <td className="px-3 py-3 text-[12.5px] text-ink-2">{isSuper(e) ? 'Super' : 'Lightning'}</td>
                      <td className="px-3 py-3 text-[13px] text-ink-2">{plainState(e.terminal_state)}</td>
                      <td className="px-3 py-3 text-[13px]">
                        {e.excluded || excluded.get(e.run_id ?? '') ? <span className="text-ink-3" title={e.excluded ?? excluded.get(e.run_id ?? '')}>doesn’t count</span> : <span className={o.text}>{o.icon} {o.label}</span>}
                      </td>
                      <td className="px-3 py-3 text-right tnum text-ink-2">{fmt.sec(e.solve_seconds)}</td>
                      <td className="px-5 py-3 text-right"><a href={storyUrl(`run=${e.run_id}`)} className="rounded-lg border border-line-2 px-3 py-1.5 text-[12.5px] font-medium hover:bg-white/[0.05]">Watch</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Chapter>
  );
}

// ---- 8. how to read this ----------------------------------------------------------------------------
const GLOSSARY: [string, ReactNode][] = [
  ['The referee', 'Code outside the model’s control. After every incident it sends real requests through the load balancer and hidden test prompts to the broken worker, and decides whether users are served and the root cause is gone. The model never grades its own work.'],
  ['Held-out (new) faults', 'Faults built after the agent and the rules were frozen. Neither was written or tuned against them, so they test whether a fix generalizes.'],
  ['False VERIFIED', 'The agent says “fixed, verified” and the referee disagrees. The most dangerous mistake an operations tool can make.'],
  ['Asked a human (REQUIRES_APPROVAL)', 'The agent found the problem but the safe repair needs a person, such as draining a worker behind a bad network link. Counted as solved when that’s the right call.'],
  ['Stepped back (ABSTAIN)', 'The agent changed nothing. Correct when nothing is wrong; an honest miss otherwise.'],
  ['Three runs per fault', 'Every fault was injected from a clean reset three times per solver. Small numbers, so we show every run rather than percentages alone.'],
];
function HowToRead() {
  return (
    <Chapter id="how-to-read" eyebrow="How to read this" title="The words on this page, in plain terms.">
      <dl className="grid gap-x-10 gap-y-6 md:grid-cols-2">
        {GLOSSARY.map(([t, d]) => (
          <div key={t}><dt className="text-[15px] font-semibold text-ink">{t}</dt><dd className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{d}</dd></div>
        ))}
      </dl>
    </Chapter>
  );
}

function Results() {
  const sb = useScoreboard();
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Nav page="results" />
      <Hero sb={sb} />
      <main>
        {!sb ? <section className="mx-auto max-w-[1180px] px-5 py-12"><Loading v={sb} /></section> : (
          <>
            <BeforeAfter sb={sb} />
            <FalseFixed sb={sb} />
            <Matrix sb={sb} />
            <BiggerModel sb={sb} />
            <Misses sb={sb} />
          </>
        )}
        <ToolCalling />
        <Runs sb={sb} />
        <HowToRead />
      </main>
      <Footer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Results /></StrictMode>);

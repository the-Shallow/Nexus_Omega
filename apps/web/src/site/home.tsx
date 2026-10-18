// The product story: one page, six chapters. The simulation is chapter four, a way in,
// not the whole story. Real numbers come from the results API.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { motion } from 'framer-motion';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '../index.css';
import './site.css';
import type { ScoreBatch } from '../lib/types';
import { FloorPlan, Loop } from './diagrams';
import { Chapter, Footer, Nav, REFERENCE_RUN, fmt, storyUrl, useBfcl, useEpisodes, useScoreboard } from './shell';
import { Dumbbell, SET_NAME, type DumbbellRow } from './charts';

const ease = [0.16, 1, 0.3, 1] as const;

function Hero() {
  return (
    <section className="mx-auto grid max-w-[1180px] items-center gap-12 px-5 pb-20 pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease }}>
        <div className="label">Self-healing for AI inference fleets</div>
        <h1 className="mt-5 text-[clamp(36px,5.2vw,64px)] font-semibold leading-[1.02] tracking-[-0.025em]" style={{ textWrap: 'balance' }}>
          A small model you can trust to fix production AI.
        </h1>
        <p className="mt-6 max-w-[52ch] text-[18px] leading-relaxed text-ink-2">
          When a model server keeps answering but stops doing the work, dashboards stay green. Nexus checks the work itself, sends a 3B-active Nemotron agent to find the cause, applies one approved fix, and lets an independent referee decide whether it worked. It never gets to grade itself.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href={storyUrl(`run=${REFERENCE_RUN}`)} className="rounded-xl bg-accent px-5 py-3 text-[15px] font-semibold text-bg">Watch a real incident</a>
          <a href="#how" className="rounded-xl border border-line-2 px-5 py-3 text-[15px] font-medium text-ink hover:bg-white/[0.04]">How it works</a>
        </div>
      </motion.div>
      <motion.figure initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, ease, delay: 0.2 }} className="m-0">
        <FloorPlan />
        <figcaption className="mt-3 font-mono text-[11.5px] text-ink-3">One recorded incident: the fault’s route in amber, the fix coming back in green.</figcaption>
      </motion.figure>
    </section>
  );
}

function Problem() {
  const bfcl = useBfcl();
  const healthy = bfcl?.find((p) => p.label.endsWith('tools-template'))?.tool_calling_score;
  const broken = bfcl?.find((p) => p.label.endsWith('vllm-32926'))?.tool_calling_score;
  return (
    <Chapter id="problem" n="01" eyebrow="The problem" title="The dashboards stayed green. The tool calls were gone."
      lede="After a routine serving upgrade, one worker kept answering every request with HTTP 200 and normal latency. But the structured tool calls that AI agents act on were silently dropped. Agents didn’t crash. They just stopped doing their jobs, and nothing alerted.">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-raised p-6">
          <div className="label">What the dashboards saw</div>
          <ul className="mt-4 space-y-2 text-[15px] text-ink-2">
            <li className="flex gap-3"><span className="text-ok">●</span>HTTP 200 on every request</li>
            <li className="flex gap-3"><span className="text-ok">●</span>Latency within the limit</li>
            <li className="flex gap-3"><span className="text-ok">●</span>Health checks passing</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-warn/30 bg-raised p-6">
          <div className="label">What the agents got</div>
          <ul className="mt-4 space-y-2 text-[15px] text-ink-2">
            <li className="flex gap-3"><span className="text-warn">○</span>Answers with no tool call in them</li>
            <li className="flex gap-3"><span className="text-warn">○</span>No error to retry on</li>
            <li className="flex gap-3"><span className="text-warn">○</span>Work quietly not done</li>
          </ul>
        </div>
      </div>
      <div className="mt-4 grid gap-4 rounded-2xl border border-line bg-raised p-6 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <div>
          <div className="label">Tool-calling score, same model</div>
          <p className="mt-2 max-w-[56ch] text-[14.5px] text-ink-2">Measured on a fixed 200-case subset of the Berkeley Function-Calling Leaderboard, once with the healthy serving profile and once with the faulty one.</p>
        </div>
        <Stat label="healthy profile" value={fmt.score(healthy)} tone="text-ok" />
        <Stat label="with the fault" value={fmt.score(broken)} tone="text-bad" />
      </div>
    </Chapter>
  );
}

function Stat({ label, value, tone = 'text-ink', sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className={`text-[44px] font-semibold leading-none tracking-tight tnum ${tone}`}>{value}</div>
      <div className="mt-2 font-mono text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      {sub && <div className="mt-1 text-[13px] text-ink-2">{sub}</div>}
    </div>
  );
}

function How() {
  return (
    <Chapter id="how" n="02" eyebrow="How it works" title="Detect, investigate, act within policy, and let someone else check."
      lede="Nexus runs one recovery loop. The agent reasons, but it never grades its own work and it can only reach the actions it has been given.">
      <Loop />
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-line p-6">
          <div className="label">The agent can</div>
          <ul className="mt-4 space-y-2 text-[15px] text-ink-2">
            <li>Read configuration, state, logs and metrics</li><li>Run declared probes, like the tool-call canary</li><li>Propose one declared action, with its evidence</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-line p-6">
          <div className="label">The agent cannot</div>
          <ul className="mt-4 space-y-2 text-[15px] text-ink-2">
            <li>Reach fault injection: that has its own token and operator</li><li>Skip the policy gate, or touch facility and hardware</li><li>Decide whether its fix worked: the referee does</li>
          </ul>
        </div>
      </div>
    </Chapter>
  );
}

function Watch() {
  const eps = useEpisodes();
  const ref = eps?.find((e) => e.run_id === REFERENCE_RUN);
  const recorded = eps ? eps.filter((e) => e.run_id && e.fault !== 'noop' && !e.contaminated).length : null;
  return (
    <Chapter id="watch" n="03" eyebrow="Watch it" title="Step inside one incident."
      lede="The simulation walks through an incident room by room: the break, the diagnosis, the repair and the proof. Recorded runs replay what really happened on the fleet.">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <a href={storyUrl(`run=${REFERENCE_RUN}`)} className="group flex flex-col justify-between gap-8 rounded-2xl border border-info/30 bg-raised p-7 transition-colors hover:border-info/60">
          <div>
            <span className="rounded-md border border-info/30 bg-info/10 px-2 py-0.5 font-mono text-[10.5px] tracking-wider text-info">RECORDED RUN · {REFERENCE_RUN}</span>
            <h3 className="mt-4 text-[26px] font-semibold leading-tight tracking-tight">Nemotron repairs a fault nobody wrote rules for</h3>
            <p className="mt-3 max-w-[48ch] text-[15px] text-ink-2">Worker a’s chat template quietly drops the tools, so the model answers in prose and no tool call ever comes back. Hand-written rules miss it every time. Nemotron finds the template, applies the reviewed serving profile, and the referee confirms the fix.</p>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[12px] text-ink-3">{ref ? `${ref.terminal_state} · solved in ${fmt.sec(ref.solve_seconds)}` : ' '}</span>
            <span className="rounded-xl bg-accent px-4 py-2 text-[14px] font-semibold text-bg">Play</span>
          </div>
        </a>
        <div className="grid gap-4">
          <a href={storyUrl('story=crah')} className="rounded-2xl border border-line bg-raised p-6 hover:border-line-2">
            <span className="rounded-md border border-replay/30 bg-replay/10 px-2 py-0.5 font-mono text-[10.5px] tracking-wider text-replay">ILLUSTRATIVE</span>
            <h3 className="mt-3 text-[18px] font-semibold">A cooling unit trips at 2 AM</h3>
            <p className="mt-1.5 text-[14px] text-ink-2">A loud, physical failure that ends with a person, on purpose.</p>
          </a>
          <a href="results.html#runs" className="rounded-2xl border border-line bg-raised p-6 hover:border-line-2">
            <span className="label">All recorded runs</span>
            <h3 className="mt-3 text-[18px] font-semibold">{recorded ? `${recorded} runs to replay` : 'Browse every run'}</h3>
            <p className="mt-1.5 text-[14px] text-ink-2">Including the ones the agent got wrong.</p>
          </a>
        </div>
      </div>
    </Chapter>
  );
}

const find = (b: ScoreBatch[] | undefined, id: string) => b?.find((x) => x.id === id)?.total;

const SETS = [
  { set: 'known', rules: 'rules-known', before: 'agent-batch1', after: 'agent-known-after' },
  { set: 'v1', rules: 'rules-heldout', before: 'agent-v1-before', after: 'agent-v1-after', reference: 'agent-super-v1' },
  { set: 'v2', rules: 'rules-v2', before: 'agent-v2-before', after: 'agent-v2-after' },
] as const;

function Evidence() {
  const sb = useScoreboard();
  const b = sb?.batches;
  const fv = (phase: 'before' | 'after') => SETS.reduce((n, s) => n + (find(b, s[phase])?.false_verified ?? 0), 0);
  const runs = (phase: 'before' | 'after') => SETS.reduce((n, s) => n + (find(b, s[phase])?.total ?? 0), 0);
  const rows: DumbbellRow[] = SETS.map((s) => ({
    key: s.set, label: SET_NAME[s.set], rules: find(b, s.rules), before: find(b, s.before), after: find(b, s.after),
    reference: 'reference' in s ? find(b, s.reference) : undefined,
  }));
  return (
    <Chapter id="evidence" n="04" eyebrow="Evidence" title="Same model, better harness, misses included."
      lede="Every episode is scored by an independent referee. We measured the same Nemotron weights before and after redesigning the harness around them, against hand-written rules, on faults the rules were written for and on two sets nobody wrote rules for.">
      <div className="rounded-2xl border border-line bg-raised p-6 md:p-8">{sb ? <Dumbbell rows={rows} referenceLabel="Nemotron Super, 4× bigger, same harness" /> : <span className="text-ink-3">–</span>}</div>
      <div className="mt-4 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
        <div className="bg-bg p-6"><Stat label="false “fixed” claims, before" value={sb ? String(fv('before')) : '–'} tone="text-bad" sub={sb ? `in ${runs('before')} runs` : undefined} /></div>
        <div className="bg-bg p-6"><Stat label="false “fixed” claims, after" value={sb ? String(fv('after')) : '–'} tone="text-ok" sub={sb ? `in ${runs('after')} runs` : undefined} /></div>
        <div className="bg-bg p-6"><Stat label="errors during one repair" value="0" sub="out of 1,550 requests, measured once" /></div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-[62ch] text-[15px] text-ink-2">Rules handle the faults they were written for. On faults nobody wrote rules for, the agent solves three times as many, and it never claims a fix it didn’t make.</p>
        <a href="results.html" className="rounded-xl border border-line-2 px-4 py-2.5 text-[14px] font-medium hover:bg-white/[0.04]">See all results</a>
      </div>
    </Chapter>
  );
}

function Next() {
  const b = useScoreboard()?.batches;
  const held = find(b, 'rules-heldout'), after = find(b, 'agent-v1-after');
  const items = [
    { tag: 'Done', t: 'Beat the rules on held-out faults', d: held && after ? `On faults nobody wrote rules for, the agent solves ${after.success} of ${after.total} and the rules ${held.success} of ${held.total}, with no false “fixed” claims.` : 'Faults nobody wrote a rule for are where an agent has to earn its place.' },
    { tag: 'Built', t: 'Break it live', d: 'Start a real fault on the fleet from the story page, watch the agent work in a live column, then replay the run it produced.' },
    { tag: 'Next', t: 'Capacity faults', d: 'The agent’s weakest fault: a worker choked under load. Its misses came from a relabel step overriding a correct first draft, which is the next thing to fix.' },
    { tag: 'Next', t: 'Test before acting', d: 'Give the agent the shadow twin: race candidate fixes in simulation before touching a real worker.' },
  ];
  return (
    <Chapter id="next" n="05" eyebrow="What’s next" title="What we set out to prove, and what comes next.">
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((x) => (
          <div key={x.t} className="rounded-2xl border border-line p-6">
            <span className={`font-mono text-[10.5px] tracking-wider ${x.tag === 'Next' ? 'text-accent' : x.tag === 'Concept' ? 'text-ink-3' : 'text-ok'}`}>{x.tag === 'Next' ? 'NEXT' : `✓ ${x.tag.toUpperCase()}`}</span>
            <h3 className="mt-2 text-[19px] font-semibold tracking-tight">{x.t}</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">{x.d}</p>
          </div>
        ))}
      </div>
    </Chapter>
  );
}

function Home() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Nav page="home" />
      <main>
        <Hero />
        <Problem />
        <How />
        <Watch />
        <Evidence />
        <Next />
      </main>
      <Footer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Home /></StrictMode>);

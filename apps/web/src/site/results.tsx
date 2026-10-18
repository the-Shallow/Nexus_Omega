// The evidence: every batch, every serving profile, every recorded run, read from the
// results API. Nothing here is illustrative; a missing value shows as a dash.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '../index.css';
import './site.css';
import type { EpisodeSummary } from '../lib/types';
import { Chapter, Footer, Nav, fmt, storyUrl, useBfcl, useEpisodes, useScoreboard } from './shell';

const OUTCOME: Record<string, string> = { VERIFIED: 'text-ok', REQUIRES_APPROVAL: 'text-warn', ABSTAIN: 'text-ink-3', ROLLED_BACK: 'text-info' };

function Bar({ value, total, tone = 'bg-accent' }: { value: number; total: number; tone?: string }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]" role="img" aria-label={`${value} of ${total}`}>
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Loading({ v }: { v: unknown }) {
  if (v === null) return <p className="text-[14px] text-ink-3">Loading…</p>;
  return <p className="text-[14px] text-bad">Couldn’t reach the results API. Start it with <code className="font-mono">./scripts/twin.sh</code>.</p>;
}

function ScoreboardSection() {
  const sb = useScoreboard();
  return (
    <Chapter id="scoreboard" eyebrow="Scoreboard" title="Rules and Nemotron, batch by batch."
      lede="Each batch is a set of episodes: inject a fault, let the solver work, then the referee scores it. A false VERIFIED means the solver claimed a fix the referee rejected.">
      {!sb ? <Loading v={sb} /> : (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full min-w-[820px] text-left text-[14px]">
            <thead className="border-b border-line text-ink-3">
              <tr className="font-mono text-[11px] uppercase tracking-wider">
                <th className="px-5 py-3 font-medium">Batch</th><th className="px-3 py-3 font-medium">Faults</th>
                <th className="w-[220px] px-3 py-3 font-medium">Solved</th><th className="px-3 py-3 font-medium">False VERIFIED</th><th className="px-5 py-3 text-right font-medium">Median time</th>
              </tr>
            </thead>
            <tbody>
              {sb.batches.map((b) => (
                <tr key={b.id} className="border-b border-line align-top last:border-0">
                  <td className="px-5 py-4">
                    <div className="font-medium text-ink">{b.label}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {Object.entries(b.faults).map(([f, c]) => (
                        <span key={f} className="rounded-md bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3">{f} {c.success}/{c.total}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-4 text-ink-2">{b.heldout ? 'held-out' : b.heldout === false ? 'known' : '–'}<div className="font-mono text-[11px] text-ink-4">{b.solver}</div></td>
                  <td className="px-3 py-4">
                    <div className="mb-1.5 font-semibold tnum">{b.total.success}/{b.total.total}</div>
                    <Bar value={b.total.success} total={b.total.total} tone={b.solver === 'agent' ? 'bg-accent' : 'bg-ink-3'} />
                  </td>
                  <td className={`px-3 py-4 tnum ${b.total.false_verified ? 'font-semibold text-bad' : 'text-ink-3'}`}>{b.total.false_verified}</td>
                  <td className="px-5 py-4 text-right tnum text-ink-2">{fmt.sec(b.total.median_s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Chapter>
  );
}

function ProfilesSection() {
  const bfcl = useBfcl();
  return (
    <Chapter id="profiles" eyebrow="Tool calling" title="The fault takes tool calling from working to zero."
      lede="The same model, scored on a fixed 200-case subset of the Berkeley Function-Calling Leaderboard under each serving profile.">
      {!bfcl ? <Loading v={bfcl} /> : (
        <div className="grid gap-4 md:grid-cols-3">
          {bfcl.map((p) => {
            const name = p.label.split('.').slice(1).join('.') || p.label;
            const good = p.tool_calling_score > 0.5;
            return (
              <div key={p.label} className="rounded-2xl border border-line bg-raised p-6">
                <div className="font-mono text-[11.5px] text-ink-3">{name}</div>
                <div className={`mt-3 text-[44px] font-semibold leading-none tracking-tight tnum ${good ? 'text-ok' : 'text-bad'}`}>{p.tool_calling_score.toFixed(2)}</div>
                <div className="mt-5 space-y-2.5">
                  {Object.entries(p.by_category).map(([cat, c]) => (
                    <div key={cat}>
                      <div className="mb-1 flex justify-between text-[12.5px] text-ink-2"><span>{cat}</span><span className="tnum">{c.passed}/{c.total}</span></div>
                      {/* Colored by the category's own score: passing "irrelevance" (no call needed) is good even on a broken profile. */}
                      <Bar value={c.passed} total={c.total} tone={c.score > 0.5 ? 'bg-ok' : 'bg-bad'} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Chapter>
  );
}

function RunsSection() {
  const eps = useEpisodes();
  const [all, setAll] = useState(false);
  const rows: EpisodeSummary[] = (eps ?? [])
    .filter((e) => all || (e.run_id && e.fault !== 'noop' && !e.contaminated))
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return (
    <Chapter id="runs" eyebrow="Runs" title="Every recorded agent run, ready to replay."
      lede="Each run with a recorded trail opens in the simulation: the real tool calls, the diagnosis, the action and the referee’s checks.">
      {!eps ? <Loading v={eps} /> : (
        <>
          <div className="mb-3 flex items-center justify-between text-[13px] text-ink-3">
            <span className="tnum">{rows.length} runs</span>
            <label className="flex cursor-pointer items-center gap-2"><input id="all-runs" type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-[var(--color-accent)]" />Include runs without a trail</label>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-line">
            <table className="w-full min-w-[760px] text-left text-[14px]">
              <thead className="border-b border-line">
                <tr className="font-mono text-[11px] uppercase tracking-wider text-ink-3">
                  <th className="px-5 py-3 font-medium">When (UTC)</th><th className="px-3 py-3 font-medium">Fault</th><th className="px-3 py-3 font-medium">Outcome</th>
                  <th className="px-3 py-3 text-right font-medium">Time</th><th className="px-3 py-3 font-medium">Run</th><th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-3 font-mono text-[12px] text-ink-3 tnum">{e.at ? `${e.at.slice(5, 10)} ${e.at.slice(11, 16)}` : '–'}</td>
                    <td className="px-3 py-3 font-medium">{e.fault ?? '–'}</td>
                    <td className="px-3 py-3 font-mono text-[12px]">
                      {e.false_verified ? <span className="font-semibold text-bad">FALSE VERIFIED</span> : <span className={OUTCOME[e.terminal_state] ?? 'text-ink-3'}>{e.terminal_state ?? '–'}</span>}
                    </td>
                    <td className="px-3 py-3 text-right tnum text-ink-2">{fmt.sec(e.solve_seconds)}</td>
                    <td className="px-3 py-3 font-mono text-[12px] text-ink-3">{e.run_id ?? 'no trail'}</td>
                    <td className="px-5 py-3 text-right">
                      {e.run_id ? <a href={storyUrl(`run=${e.run_id}`)} className="rounded-lg border border-line-2 px-3 py-1.5 text-[12.5px] font-medium hover:bg-white/[0.05]">Watch</a> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Chapter>
  );
}

function Results() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Nav page="results" />
      <section className="mx-auto max-w-[1180px] px-5 pb-6 pt-16">
        <div className="label">Results</div>
        <h1 className="mt-4 max-w-[22ch] text-[clamp(32px,4.4vw,52px)] font-semibold leading-[1.05] tracking-tight" style={{ textWrap: 'balance' }}>The evidence, including the misses.</h1>
        <p className="mt-5 max-w-[62ch] text-[17px] leading-relaxed text-ink-2">Scores from episodes on the real fleet: rule baseline and Nemotron on the same faults, tool-calling quality per serving profile, and every recorded run.</p>
      </section>
      <main>
        <ScoreboardSection />
        <ProfilesSection />
        <RunsSection />
      </main>
      <Footer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Results /></StrictMode>);

// Story-mode overlays: top bar, step rail, room title, reality bar, transport, finale.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../../lib/api';
import type { EpisodeSummary } from '../../lib/types';
import { ACTS, actsOf, type Hop, type Reality, type Story } from '../script/types';
import { ROOM, type RoomId } from '../world/layout';

const ease = [0.16, 1, 0.3, 1] as const;

export function TopBar({ stories, story, onStory, onRun, loading, clock, engineer, setEngineer }: {
  stories: Story[]; story: Story; onStory: (s: Story) => void; onRun: (runId: string) => void; loading: string | null;
  clock: string; engineer: boolean; setEngineer: (v: boolean) => void;
}) {
  const [picker, setPicker] = useState(false);
  const real = story.mode === 'real';
  return (
    <motion.header initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease }}
      className="glass absolute left-4 right-4 top-4 z-20 flex h-14 items-center gap-4 rounded-2xl px-4">
      <a href="./" className="flex items-center gap-2.5" title="Back to the product story">
        <span className="grid size-8 place-items-center rounded-lg bg-accent text-[17px] font-bold text-bg">Ω</span>
        <div className="leading-tight">
          <div className="text-[14px] font-semibold">Nexus</div>
          <div className="label !text-[9.5px]">simulation</div>
        </div>
      </a>
      <div className="mx-auto flex gap-1 rounded-xl bg-white/[0.04] p-1">
        {stories.map((s) => (
          <button key={s.id} onClick={() => { setPicker(false); onStory(s); }}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors ${s.id === story.id ? 'bg-white/[0.09] text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
            {s.name}
          </button>
        ))}
        <span className="mx-1 w-px self-stretch bg-line-2" />
        <button onClick={() => setPicker((p) => !p)}
          className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors ${real || picker ? 'bg-white/[0.09] text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
          {loading ? `Loading ${loading}…` : real ? story.short : 'Real runs'} <span className="text-ink-4">▾</span>
        </button>
      </div>
      <AnimatePresence>{picker && <RunPicker current={real ? story.short : null} onPick={(id) => { setPicker(false); onRun(id); }} />}</AnimatePresence>
      <div className="font-mono text-[15px] tnum text-ink-2">{clock}</div>
      <div className="flex rounded-xl bg-white/[0.04] p-1 text-[12px]">
        {(['Story', 'Engineer'] as const).map((m) => (
          <button key={m} onClick={() => setEngineer(m === 'Engineer')}
            className={`rounded-lg px-2.5 py-1 font-medium ${(m === 'Engineer') === engineer ? 'bg-white/[0.09] text-ink' : 'text-ink-3'}`}>{m}</button>
        ))}
      </div>
      <span className={`rounded-lg border px-2.5 py-1 font-mono text-[10.5px] tracking-wider ${real ? 'border-info/30 bg-info/10 text-info' : 'border-replay/30 bg-replay/10 text-replay'}`}>{story.badge}</span>
    </motion.header>
  );
}

export function StepRail({ story, hop, engineer, waiting, onApprove, onGo }: {
  story: Story; hop: number; engineer: boolean; waiting: boolean; onApprove: () => void; onGo: (i: number) => void;
}) {
  const cur = useRef<HTMLButtonElement>(null);
  useEffect(() => { cur.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [hop, story]);
  const acts = actsOf(story);
  const now = acts[hop];
  return (
    <motion.aside initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.8, ease, delay: 0.1 }}
      className="glass absolute bottom-24 left-4 top-[88px] z-10 flex w-[380px] flex-col rounded-2xl">
      <div className="flex-1 overflow-y-auto px-2.5 py-3">
        {ACTS.map((a) => {
          const idx = story.hops.map((_, i) => i).filter((i) => acts[i] === a.n);
          if (!idx.length) return null;
          const state = a.n < now ? 'done' : a.n === now ? 'open' : 'later';
          return (
            <div key={a.n} className={`mb-1.5 rounded-xl ${state === 'open' ? 'bg-white/[0.035] pb-1.5' : ''}`}>
              <button onClick={() => onGo(idx[0])} className="flex w-full items-baseline gap-3 rounded-xl px-3 pb-1.5 pt-2.5 text-left">
                <span className={`font-mono text-[10.5px] tracking-[0.18em] ${state === 'later' ? 'text-ink-4' : 'text-accent'}`}>ACT {a.n}</span>
                <span className={`text-[14.5px] font-semibold ${state === 'later' ? 'text-ink-3' : 'text-ink'}`}>{a.title}</span>
                <span className="ml-auto font-mono text-[10.5px] text-ink-4">{state === 'done' ? '✓' : `${idx.length} steps`}</span>
              </button>
              <AnimatePresence initial={false}>
                {state === 'open' && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.5, ease }} className="overflow-hidden">
                    {idx.map((i) => {
                      const h = story.hops[i];
                      const st = i < hop ? 'past' : i === hop ? 'now' : 'next';
                      return (
                        <button key={story.id + h.id} ref={i === hop ? cur : undefined} onClick={() => onGo(i)}
                          className={`relative block w-full rounded-lg px-3 text-left transition-colors ${st === 'now' ? 'py-2.5' : 'py-1.5 hover:bg-white/[0.03]'}`}>
                          {st === 'now' && <span className="absolute inset-y-2.5 left-0 w-[2px] rounded-full bg-accent" />}
                          <div className="flex items-center gap-2.5">
                            <StepDot state={st} />
                            <span className={`text-[13.5px] font-medium ${st === 'now' ? 'text-ink' : st === 'past' ? 'text-ink-2' : 'text-ink-4'}`}>{h.title}</span>
                            {h.room && <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-ink-4">{ROOM[h.room].name}</span>}
                          </div>
                          <AnimatePresence initial={false}>
                            {st === 'now' && (
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.5, ease }} className="overflow-hidden pl-[26px]">
                                <p className="pt-2 text-[15px] leading-[1.5] text-ink">{h.plain}</p>
                                <p className="mt-2 font-mono text-[11.5px] leading-snug text-ink-3">{h.tech}</p>
                                {engineer && h.engineer && (
                                  <ul className="mt-2 space-y-1 border-l border-line-2 pl-3">
                                    {h.engineer.map((l) => <li key={l} className="font-mono text-[11px] leading-snug text-ink-3">{l}</li>)}
                                  </ul>
                                )}
                                {h.wait && waiting && (
                                  <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onApprove(); }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') onApprove(); }}
                                    className="mt-3 inline-flex items-center gap-2 rounded-xl bg-warn px-3.5 py-2 text-[13px] font-semibold text-bg">
                                    <span className="size-2 animate-pulse rounded-full bg-bg" />{h.wait.label}
                                  </span>
                                )}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </motion.aside>
  );
}

function StepDot({ state }: { state: 'past' | 'now' | 'next' }) {
  if (state === 'past') return <span className="grid size-4 place-items-center rounded-full bg-accent/20 text-[9px] text-accent">✓</span>;
  if (state === 'now') return (
    <span className="relative grid size-4 place-items-center">
      <motion.span className="absolute inset-0 rounded-full border border-accent" animate={{ scale: [0.7, 1.5], opacity: [0.9, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }} />
      <span className="size-2 rounded-full bg-accent shadow-[0_0_10px_rgb(118_185_0/0.9)]" />
    </span>
  );
  return <span className="grid size-4 place-items-center"><span className="size-1.5 rounded-full bg-ink-4" /></span>;
}

export function RoomTitle({ h, room, subs = {} }: { h: Hop; room: RoomId | null; subs?: Partial<Record<RoomId, string>> }) {
  const r = room ? ROOM[room] : null;
  const key = r?.id ?? (h.finale ? 'finale' : 'floor');
  return (
    <div className="pointer-events-none absolute right-8 top-[100px] z-10 text-right">
      <AnimatePresence mode="wait">
        <motion.div key={key} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.6, ease }}>
          <div className="font-mono text-[12px] tracking-[0.2em] text-accent">{r ? r.n : h.finale ? 'OVERVIEW' : 'THE FLOOR'}</div>
          <div className="mt-1 text-[34px] font-semibold leading-none tracking-tight">{r ? r.name : h.finale ? 'The whole picture' : 'One floor, six rooms'}</div>
          <div className="mt-2 text-[13px] text-ink-3">{r ? subs[r.id] ?? r.sub : h.finale ? 'the incident’s path through the system' : 'callers → door → GPUs → signals → Nexus'}</div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function RealityBar({ r }: { r: Reality }) {
  const realC = r.tone === 'ok' ? 'bg-ok' : r.tone === 'lie' ? 'bg-warn' : 'bg-bad';
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.6, ease }}
      className="glass absolute bottom-24 right-4 z-10 w-[300px] rounded-2xl p-4">
      <div className="label mb-3">{r.head ?? 'What the dashboards say vs what’s true'}</div>
      <Row dot={r.labels ? 'bg-info' : 'bg-ok'} k={r.labels?.[0] ?? 'Dashboards'} v={r.dash} />
      <div className="my-2 h-px bg-line" />
      <Row dot={realC} k={r.labels?.[1] ?? 'Reality'} v={r.real} pulse={r.tone !== 'ok'} />
    </motion.div>
  );
}

function Row({ dot, k, v, pulse }: { dot: string; k: string; v: string; pulse?: boolean }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${dot} ${pulse ? 'animate-pulse' : ''}`} />
      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink-4">{k}</div>
        <div className="text-[14px] font-medium text-ink">{v}</div>
      </div>
    </div>
  );
}

export function Transport({ story, hop, playing, setPlaying, speed, setSpeed, onGo, waiting }: {
  story: Story; hop: number; playing: boolean; setPlaying: (p: boolean) => void; speed: number; setSpeed: (s: number) => void; onGo: (i: number) => void; waiting: boolean;
}) {
  const h = story.hops[hop];
  const btn = 'grid size-9 place-items-center rounded-xl text-ink-2 hover:bg-white/[0.06] hover:text-ink';
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease, delay: 0.2 }}
      className="glass absolute bottom-4 left-1/2 z-20 flex h-14 -translate-x-1/2 items-center gap-2 rounded-2xl px-3">
      <button className={btn} onClick={() => onGo(hop - 1)} aria-label="Previous">◀</button>
      <button className="grid size-10 place-items-center rounded-xl bg-accent text-bg" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button className={btn} onClick={() => onGo(hop + 1)} aria-label="Next">▶</button>
      <div className="mx-2 flex items-center gap-1.5">
        {story.hops.map((x, i) => (
          <button key={story.id + x.id} onClick={() => onGo(i)} title={x.title}
            className={`relative h-1.5 overflow-hidden rounded-full transition-all ${i === hop ? 'w-10 bg-white/15' : i < hop ? 'w-4 bg-accent/70' : 'w-4 bg-white/12'}`}>
            {i === hop && (
              <span key={`${story.id}-${hop}-${playing}-${waiting}`} className="story-fill absolute inset-y-0 left-0 bg-accent"
                style={{ animationDuration: `${h.dur / speed}s`, animationPlayState: playing && !waiting ? 'running' : 'paused' }} />
            )}
          </button>
        ))}
      </div>
      <button className="rounded-lg px-2 py-1 font-mono text-[12px] text-ink-2 hover:bg-white/[0.06]" onClick={() => setSpeed(speed === 1 ? 2 : 1)}>{speed}×</button>
    </motion.div>
  );
}

const OUTCOME_STYLE: Record<string, string> = {
  VERIFIED: 'text-ok', REQUIRES_APPROVAL: 'text-warn', ABSTAIN: 'text-ink-3', ROLLED_BACK: 'text-info',
};

/** Recorded agent runs from /api/results/episodes: one row per run with a trail. */
function RunPicker({ current, onPick }: { current: string | null; onPick: (runId: string) => void }) {
  const [rows, setRows] = useState<EpisodeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.episodes({ solver: 'agent' })
      .then((list) => setRows(list
        .filter((e) => e.run_id && e.fault !== 'noop' && !e.contaminated)
        .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))))
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35, ease }}
      className="glass-strong absolute left-1/2 top-[64px] z-30 max-h-[60vh] w-[520px] -translate-x-1/2 overflow-y-auto rounded-2xl p-2">
      <div className="label px-3 pb-2 pt-2">Recorded agent runs · from evidence/</div>
      {error && <div className="px-3 py-2 text-[13px] text-bad">Couldn’t load runs: {error}</div>}
      {!rows && !error && <div className="px-3 py-2 text-[13px] text-ink-3">Loading…</div>}
      {rows?.map((e) => (
        <button key={e.id} onClick={() => onPick(e.run_id!)}
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-white/[0.05] ${e.run_id === current ? 'bg-white/[0.06]' : ''}`}>
          <span className="w-[150px] truncate text-[13px] font-medium text-ink">{e.fault ?? '—'}</span>
          <span className={`w-[150px] font-mono text-[11px] ${e.false_verified ? 'text-bad' : OUTCOME_STYLE[e.terminal_state] ?? 'text-ink-3'}`}>
            {e.false_verified ? 'FALSE VERIFIED' : e.terminal_state ?? '—'}
          </span>
          <span className="font-mono text-[11px] text-ink-4">{e.at ? e.at.slice(11, 16) : ''}</span>
          <span className="ml-auto font-mono text-[11px] text-ink-4">{e.run_id}</span>
        </button>
      ))}
    </motion.div>
  );
}

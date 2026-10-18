// Story mode: the world fills the screen; the narrative floats over it in glass.
// Scripted stories play on 8 illustrative replicas; ?run=<id> replays a recorded run
// on the real 2-worker fleet. With no deep link, this is the landing page: a short
// brief on the left over the live world, until the visitor starts the demo.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../lib/api';
import { SHOT, STORIES, useDirector } from './director';
import { BreakLive } from './live/BreakLive';
import { LiveConsole } from './live/LiveConsole';
import { useLiveFleet } from './live/useLiveFleet';
import { useLiveRun } from './live/useLiveRun';
import { useLiveStatus } from './live/useLiveStatus';
import { useLiveWorld } from './live/useLiveWorld';
import { loadRealStory } from './script/real';
import type { Story } from './script/types';
import { actsOf } from './script/types';
import { Caption } from './ui/caption';
import { ActCard, FlowMapPanel } from './ui/flow';
import { INTRO_WIDTH, IntroPanel, LandingBar, stageBeat } from './ui/intro';
import { RealityBar, RoomTitle, StepRail, TopBar, Transport } from './ui/parts';
import { FLEET_REAL, FLEET_SCRIPTED } from './world/layout';
import { World } from './world/world';

const RAIL = 216;   // progress spine plus margin, px
const LIVE_COL = 396;   // live console plus margin, px
const params = new URLSearchParams(location.search);
/** The recorded run the landing page plays behind the brief. */
// Held-out v1, after the redesign: a fault nobody wrote rules for, repaired and VERIFIED.
const LANDING_RUN = 'run-ce0c86a3';
/** No deep link means the landing page. ?intro=N (review screenshots) opens it at beat N. */
const LANDING = params.has('intro') || !['run', 'story', 'hop', 'shot'].some((k) => params.has(k));
const FIRST_BEAT = Math.min(2, Math.max(0, Number(params.get('intro') || 1) - 1));

export default function StoryApp() {
  const runParam = LANDING ? LANDING_RUN : params.get('run');
  const [story, setStory] = useState<Story | null>(() => (runParam ? null : STORIES.find((s) => s.id === params.get('story')) ?? STORIES[0]));
  const [loading, setLoading] = useState<string | null>(runParam);
  const [error, setError] = useState<string | null>(null);

  const openRun = (runId: string) => {
    setLoading(runId);
    setError(null);
    loadRealStory(runId)
      .then((s) => setStory(s))
      // On the landing page, fall back to the illustrative story quietly; elsewhere, say what failed.
      .catch((e: Error) => { if (!LANDING) setError(`Couldn’t load ${runId}: ${e.message}`); setStory((cur) => cur ?? STORIES[0]); })
      .finally(() => setLoading(null));
  };
  // Load a deep-linked run once, on mount.
  useEffect(() => { if (runParam) openRun(runParam); }, []);

  if (!story) return <div className="fixed inset-0 grid place-items-center font-mono text-[13px] text-ink-3">{error ?? (LANDING ? '' : `Loading ${loading}…`)}</div>;
  return <Player story={story} onStory={setStory} onRun={openRun} loading={loading} error={error} />;
}

function Player({ story, onStory, onRun, loading, error }: { story: Story; onStory: (s: Story) => void; onRun: (id: string) => void; loading: string | null; error: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [engineer, setEngineer] = useState(false);
  const [intro, setIntro] = useState(LANDING);
  const [beat, setBeat] = useState(FIRST_BEAT);

  // Break it live: only offered while the Brev operator answers. A live run takes the world
  // over (it mirrors the real fleet), then hands its finished run to the director as an instant replay.
  const liveOn = useLiveStatus();
  const { run: live, start: startLive, clear: clearLive } = useLiveRun();
  const liveFrame = useLiveFleet(!!live);
  const [replayed, setReplayed] = useState<string | null>(null);

  // One world per fleet: the scripted 8 replicas, or the real 2 workers (always, during a live run).
  const fleet = live || story.mode === 'real' ? FLEET_REAL : FLEET_SCRIPTED;
  useEffect(() => {
    const w = new World(host.current!, fleet, story.subs);
    setWorld(w);
    (window as unknown as { story: unknown }).story = { world: w };
    return () => { w.dispose(); setWorld(null); };
  }, [fleet]);

  // Only drive a world built for this story's fleet.
  const ready = world && world.fleet === fleet ? world : null;
  const d = useDirector(ready, story, !intro && !live);
  useLiveWorld(ready, live, liveFrame);

  // The referee has scored it: replay that exact run, marked as just-now live.
  useEffect(() => {
    if (live?.phase !== 'done' || !live.replayRun) return;
    const id = live.replayRun;
    loadRealStory(id)
      .then((s) => { onStory({ ...s, badge: 'LIVE · just now' }); setReplayed(id); })
      .catch(() => onRun(id))
      .finally(clearLive);
  }, [live?.phase]);
  useEffect(() => {
    if (!replayed) return;
    const t = setTimeout(() => setReplayed(null), 9000);
    return () => clearTimeout(t);
  }, [replayed]);

  // The live run didn't make it: play the newest clean recorded run of the same fault instead.
  const fallback = () => {
    const fault = live?.fault;
    clearLive();
    if (!fault) return;
    api.episodes({ solver: 'agent', fault }).then((rows) => {
      const usable = rows.filter((e) => e.run_id && !e.contaminated).sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
      const pick = usable.find((e) => e.success && !e.false_verified) ?? usable[0];
      if (pick?.run_id) onRun(pick.run_id);
    }).catch(() => {});
  };

  // While the brief is up, the world shows whatever the current beat talks about.
  useEffect(() => {
    if (!ready || !intro) return;
    stageBeat(ready, story, beat, SHOT);
    if (SHOT) ready.stage.warm(4);
  }, [ready, story, intro, beat]);

  // Keep the focused room centred in the space the panels leave free (the finale's map spans the full width).
  const finale = !!d.h.finale;
  useEffect(() => {
    if (!world) return;
    const place = (instant: boolean) => world.setInset((intro ? INTRO_WIDTH + 16 : live ? -LIVE_COL : finale ? 0 : RAIL) / (2 * window.innerWidth), instant);
    place(SHOT);
    const onResize = () => place(true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [world, finale, intro, !!live]);

  // A title card when the story enters a new act.
  const acts = actsOf(story);
  const [card, setCard] = useState<1 | 2 | 3 | null>(null);
  useEffect(() => {
    if (SHOT || intro || live || d.h.finale || (d.hop > 0 && acts[d.hop - 1] === acts[d.hop])) return;
    setCard(acts[d.hop]);
    const t = setTimeout(() => setCard(null), 2600);
    return () => clearTimeout(t);
  }, [story, d.hop, intro]);

  const next = story.mode === 'real' ? STORIES[0] : STORIES.find((s) => s.id !== story.id)!;
  // One tree for both modes, so the 3D canvas (inside `host`) survives the switch.
  return (
    <div className="fixed inset-0">
      <div ref={host} className="absolute inset-0 isolate" />
      {intro ? (
        <>
          {/* A soft shade behind the brief so its text reads over any part of the scene. */}
          <div className="pointer-events-none absolute inset-y-0 left-0 w-[640px] bg-gradient-to-r from-bg/80 via-bg/30 to-transparent" />
          <LandingBar />
          <IntroPanel beat={beat} onBeat={setBeat} onStart={() => setIntro(false)} />
        </>
      ) : (
        <>
          <TopBar stories={STORIES} story={live ? { ...story, badge: 'LIVE · Brev H100' } : story} onStory={onStory} onRun={onRun} loading={loading} clock={live ? '' : d.h.clock} engineer={engineer} setEngineer={setEngineer} onAbout={() => { d.setPlaying(false); setBeat(0); setIntro(true); }}
            extra={liveOn || live ? <BreakLive busy={!!live && live.phase !== 'failed'} onPick={startLive} /> : null} />
          {live ? (
            <AnimatePresence>
              <LiveConsole key="live" run={live} fleet={liveFrame} onFallback={fallback} onClose={clearLive} />
            </AnimatePresence>
          ) : (
            <>
              {!finale && <StepRail story={story} hop={d.hop} onGo={d.go} />}
              {!finale && <Caption h={d.h} act={acts[d.hop]} engineer={engineer} waiting={d.waiting} onApprove={d.approve} left={RAIL} />}
              {!finale && <RoomTitle h={d.h} room={d.room} subs={story.subs} />}
              <AnimatePresence>
                {/* Only when the two sides disagree: agreement needs no box. */}
                {d.h.reality && d.h.reality.tone !== 'ok' && !finale && <RealityBar key="reality" r={d.h.reality} />}
                {card && !finale && <ActCard key={`act-${card}`} act={card} />}
                {finale && <FlowMapPanel key={`flow-${story.id}`} story={story} onReplay={d.restart} onOther={() => onStory(next)} otherLabel={story.mode === 'real' ? 'Illustrative scenario' : 'The other scenario'} />}
                {replayed && (
                  <motion.div key="replayed" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                    className="glass absolute left-1/2 top-[70px] z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl px-4 py-2 text-[13px]">
                    <span className="size-2 rounded-full bg-bad" />
                    <span className="text-ink">Instant replay of the run that just finished</span>
                    <span className="font-mono text-[11.5px] text-ink-3">{replayed}</span>
                  </motion.div>
                )}
              </AnimatePresence>
              <Transport story={story} hop={d.hop} playing={d.playing} setPlaying={d.setPlaying} speed={d.speed} setSpeed={d.setSpeed} onGo={d.go} waiting={d.waiting} />
            </>
          )}
          {error && <div className="glass absolute left-1/2 top-[70px] z-30 -translate-x-1/2 rounded-xl px-4 py-2 text-[13px] text-bad">{error}</div>}
        </>
      )}
    </div>
  );
}

// Story mode: the world fills the screen; the narrative floats over it in glass.
// Scripted stories play on 8 illustrative replicas; ?run=<id> replays a recorded run
// on the real 2-worker fleet.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { SHOT, STORIES, useDirector } from './director';
import { loadRealStory } from './script/real';
import type { Story } from './script/types';
import { Finale, RealityBar, RoomTitle, StepRail, TopBar, Transport } from './ui/parts';
import { FLEET_REAL, FLEET_SCRIPTED } from './world/layout';
import { World } from './world/world';

const RAIL = 400;   // left rail plus margin, px
const CARD = 380;   // finale card plus margin, px
const params = new URLSearchParams(location.search);

export default function StoryApp() {
  const runParam = params.get('run');
  const [story, setStory] = useState<Story | null>(() => (runParam ? null : STORIES.find((s) => s.id === params.get('story')) ?? STORIES[0]));
  const [loading, setLoading] = useState<string | null>(runParam);
  const [error, setError] = useState<string | null>(null);

  const openRun = (runId: string) => {
    setLoading(runId);
    setError(null);
    loadRealStory(runId)
      .then((s) => setStory(s))
      .catch((e: Error) => { setError(`Couldn’t load ${runId}: ${e.message}`); setStory((cur) => cur ?? STORIES[0]); })
      .finally(() => setLoading(null));
  };
  // Load a deep-linked run once, on mount.
  useEffect(() => { if (runParam) openRun(runParam); }, []);

  if (!story) return <div className="fixed inset-0 grid place-items-center font-mono text-[13px] text-ink-3">{error ?? `Loading ${loading}…`}</div>;
  return <Player story={story} onStory={setStory} onRun={openRun} loading={loading} error={error} />;
}

function Player({ story, onStory, onRun, loading, error }: { story: Story; onStory: (s: Story) => void; onRun: (id: string) => void; loading: string | null; error: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [engineer, setEngineer] = useState(false);

  // One world per fleet: the scripted 8 replicas, or the real 2 workers.
  const fleet = story.mode === 'real' ? FLEET_REAL : FLEET_SCRIPTED;
  useEffect(() => {
    const w = new World(host.current!, fleet, story.subs);
    setWorld(w);
    (window as unknown as { story: unknown }).story = { world: w };
    return () => { w.dispose(); setWorld(null); };
  }, [fleet]);

  // Only drive a world built for this story's fleet.
  const d = useDirector(world && world.fleet === fleet ? world : null, story);

  // Keep the focused room centred in the space the panels leave free.
  const finale = !!d.h.finale;
  useEffect(() => {
    if (!world) return;
    const place = (instant: boolean) => world.setInset((finale ? -CARD : RAIL) / (2 * window.innerWidth), instant);
    place(SHOT);
    const onResize = () => place(true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [world, finale]);

  const next = story.mode === 'real' ? STORIES[0] : STORIES.find((s) => s.id !== story.id)!;
  return (
    <div className="fixed inset-0">
      <div ref={host} className="absolute inset-0" />
      <TopBar stories={STORIES} story={story} onStory={onStory} onRun={onRun} loading={loading} clock={d.h.clock} engineer={engineer} setEngineer={setEngineer} />
      {!finale && <StepRail story={story} hop={d.hop} engineer={engineer} waiting={d.waiting} onApprove={d.approve} onGo={d.go} />}
      {!finale && <RoomTitle h={d.h} room={d.room} subs={story.subs} />}
      <AnimatePresence>
        {d.h.reality && !finale && <RealityBar key="reality" r={d.h.reality} />}
        {finale && <Finale key={`finale-${story.id}`} story={story} onReplay={d.restart} onOther={() => onStory(next)} />}
      </AnimatePresence>
      {error && <div className="glass absolute left-1/2 top-[84px] z-30 -translate-x-1/2 rounded-xl px-4 py-2 text-[13px] text-bad">{error}</div>}
      <Transport story={story} hop={d.hop} playing={d.playing} setPlaying={d.setPlaying} speed={d.speed} setSpeed={d.setSpeed} onGo={d.go} waiting={d.waiting} />
    </div>
  );
}

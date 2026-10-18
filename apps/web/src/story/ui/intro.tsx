// The landing intro: a short brief on the left while the live 3D world plays behind it.
// Three beats, one per scroll; each beat moves the backdrop to the room it talks about.
// Scrolling past the last beat (or "Watch the demo") hands over to the story.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../../lib/api';
import { snapshotAt, type Story } from '../script/types';
import type { World } from '../world/world';

const ease = [0.16, 1, 0.3, 1] as const;
export const INTRO_WIDTH = 460;

/** Beat text slides the way you scrolled: in from below going forward, from above going back. */
const slide = {
  enter: (d: number) => ({ opacity: 0, y: 22 * d, filter: 'blur(6px)' }),
  center: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.6, ease } },
  exit: (d: number) => ({ opacity: 0, y: -14 * d, filter: 'blur(4px)', transition: { duration: 0.22, ease: [0.4, 0, 1, 1] as const } }),
};
/** A wheel gesture ends after this much quiet. Trackpad momentum keeps firing well past any fixed lock. */
const GESTURE_GAP_MS = 200;
const GESTURE_MIN_DELTA = 40;

/** Which hop of the story each beat borrows its scene from, and where the camera goes. */
function beatScene(story: Story, beat: number) {
  const hops = story.hops;
  const find = (p: (id: string, room: string | null) => boolean, fallback: number) => {
    const i = hops.findIndex((h) => p(h.id, h.room));
    return i >= 0 ? i : Math.min(fallback, hops.length - 1);
  };
  if (beat === 0) return { hop: 0, cam: 'landing' };
  if (beat === 1) return { hop: find((id) => id === 'detect' || id === 'canary', 2), cam: 'gpu' };
  return { hop: find((id, room) => id.startsWith('investigate') || id === 'diagnose' || room === 'doctors', 3), cam: 'doctors' };
}

/** Put the world into the state a beat talks about. Same mechanics as entering a hop, without the timeline. */
export function stageBeat(world: World, story: Story, beat: number, instant = false) {
  const { hop, cam } = beatScene(story, beat);
  const h = story.hops[hop];
  world.clearTimers();
  world.configureTwin(story.candidates);
  const snap = snapshotAt(story, hop);
  world.apply(snap.blocks);
  if (h.set) world.apply(h.set);
  for (const b of h.beats ?? []) { if (b.set) world.apply(b.set); if (!b.cam) b.fx?.(world); }
  world.light({ ...snap.paths, ...h.paths });
  world.finale(null);
  world.ambientOn = beat === 0;
  world.setFog(beat === 0 ? 26 : 18, beat === 0 ? 70 : 52);
  // Light the room the camera shows, which isn't always the borrowed hop's room.
  world.focus(beat === 0 ? null : beat === 1 ? 'gpu' : 'doctors');
  const fly = world.cam(cam, instant ? 0 : 2.6);
  if (beat === 0) fly.then(() => world.stage.orbit([-2.5, -0.5], 27, 15, 0.02));
}

interface Stat { value: string; label: string; tone: 'ok' | 'bad' | 'ink' }

function useStats() {
  const [s, setS] = useState<{ healthy?: number; broken?: number; final?: string; fv?: number }>({});
  useEffect(() => {
    api.bfcl().then((p) => setS((x) => ({
      ...x,
      healthy: p.find((q) => q.label.endsWith('tools-template'))?.tool_calling_score,
      broken: p.find((q) => q.label.endsWith('vllm-32926'))?.tool_calling_score,
    }))).catch(() => {});
    api.scoreboard().then((b) => {
      const f = b.batches.find((x) => x.id === 'agent-final-32926')?.total;
      const b1 = b.batches.find((x) => x.id === 'agent-batch1')?.total;
      setS((x) => ({ ...x, final: f ? `${f.success}/${f.total}` : undefined, fv: b1?.false_verified }));
    }).catch(() => {});
  }, []);
  return s;
}

export function IntroPanel({ beat, onBeat, onStart }: { beat: number; onBeat: (i: number) => void; onStart: () => void }) {
  const st = useStats();
  const beats: { title: string; body: string; stats?: Stat[]; caption?: string }[] = [
    {
      title: 'Nexus keeps AI services honest.',
      body: 'AI agents rely on model servers that can fail silently: still answering, still fast, but no longer doing the work. Nexus checks the work itself, finds the cause, applies one approved fix, and lets an independent referee decide whether it worked.',
      caption: 'Behind this panel: a real 2-worker vLLM fleet on one H100, replayed from a recorded run.',
    },
    {
      title: 'It catches what dashboards miss.',
      body: 'On the GPU floor, target-a still answers with HTTP 200 at normal speed, but the tool calls inside its answers are gone. Dashboards stay green. A canary that checks the work turns red.',
      stats: st.healthy !== undefined && st.broken !== undefined
        ? [{ value: st.healthy.toFixed(2), label: 'tool-calling score, healthy', tone: 'ok' }, { value: st.broken.toFixed(2), label: 'same model, with the fault', tone: 'bad' }]
        : undefined,
    },
    {
      title: 'An agent investigates. A referee decides.',
      body: 'NVIDIA Nemotron gathers evidence through declared tools and proposes one action. A policy gate checks it before anything changes, and an independent referee, not the agent, decides whether it worked.',
      stats: st.final !== undefined
        ? [{ value: st.final, label: 'verified, final setup', tone: 'ok' }, ...(st.fv !== undefined ? [{ value: String(st.fv), label: 'false VERIFIED in batch 1, counted', tone: 'bad' as const }] : [])]
        : undefined,
    },
  ];
  const b = beats[beat];
  const prev = useRef(beat);
  const dir = beat >= prev.current ? 1 : -1;
  useEffect(() => { prev.current = beat; }, [beat]);

  // One beat per gesture (a whole swipe or wheel spin, momentum included; a key; a touch swipe).
  // Past the last beat, the demo starts.
  const lock = useRef(0);
  const wheel = useRef({ last: 0, sum: 0, fired: false });
  useEffect(() => {
    const step = (dir: 1 | -1) => {
      const now = performance.now();
      if (now < lock.current) return;
      lock.current = now + 450;
      if (dir > 0) { if (beat >= beats.length - 1) onStart(); else onBeat(beat + 1); }
      else if (beat > 0) onBeat(beat - 1);
    };
    const onWheel = (e: WheelEvent) => {
      const w = wheel.current, now = performance.now();
      if (now - w.last > GESTURE_GAP_MS) { w.sum = 0; w.fired = false; }
      w.last = now;
      w.sum += e.deltaY;
      if (!w.fired && Math.abs(w.sum) > GESTURE_MIN_DELTA) { w.fired = true; step(w.sum > 0 ? 1 : -1); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); step(1); }
      else if (['ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); step(-1); }
      else if (e.key === 'Enter') onStart();
    };
    let y0 = 0;
    const onTouchStart = (e: TouchEvent) => { y0 = e.touches[0].clientY; };
    const onTouchEnd = (e: TouchEvent) => { const dy = y0 - e.changedTouches[0].clientY; if (Math.abs(dy) > 40) step(dy > 0 ? 1 : -1); };
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [beat, beats.length, onBeat, onStart]);

  return (
    <motion.aside initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -60 }} transition={{ duration: 0.9, ease }}
      className="absolute bottom-3 left-3 top-[72px] z-20 flex flex-col justify-between overflow-y-auto rounded-2xl border border-white/[0.07] bg-[rgb(9_11_13/0.72)] p-7 backdrop-blur-xl"
      style={{ width: INTRO_WIDTH }} aria-label="What is Nexus">
      <div>
        <div className="flex items-center justify-between">
          <span className="label">Self-healing for AI inference</span>
          <div className="flex gap-1.5" role="tablist" aria-label="Intro">
            {beats.map((x, i) => (
              <button key={x.title} role="tab" aria-selected={i === beat} aria-label={`Part ${i + 1}`} onClick={() => onBeat(i)}
                className={`h-1.5 rounded-full transition-all ${i === beat ? 'w-6 bg-accent' : 'w-1.5 bg-white/25 hover:bg-white/40'}`} />
            ))}
          </div>
        </div>
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div key={beat} custom={dir} variants={slide} initial="enter" animate="center" exit="exit" className="mt-10">
            <div className="font-mono text-[12px] text-accent">0{beat + 1}</div>
            <h1 className="mt-3 text-[36px] font-semibold leading-[1.06] tracking-[-0.02em]" style={{ textWrap: 'balance' }}>{b.title}</h1>
            <p className="mt-5 text-[16px] leading-relaxed text-ink-2">{b.body}</p>
            {b.stats && (
              <div className="mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
                {b.stats.map((s) => (
                  <div key={s.label} className="bg-[rgb(9_11_13/0.9)] p-4">
                    <div className={`text-[30px] font-semibold leading-none tracking-tight tnum ${s.tone === 'ok' ? 'text-ok' : s.tone === 'bad' ? 'text-bad' : 'text-ink'}`}>{s.value}</div>
                    <div className="mt-2 text-[12px] leading-snug text-ink-3">{s.label}</div>
                  </div>
                ))}
              </div>
            )}
            {b.caption && <p className="mt-6 font-mono text-[11.5px] leading-relaxed text-ink-3">{b.caption}</p>}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="mt-10">
        <div className="flex flex-wrap gap-2">
          <button onClick={onStart} className="rounded-xl bg-accent px-5 py-3 text-[15px] font-semibold text-bg">Watch the demo ▸</button>
          <a href="about.html" className="rounded-xl border border-line-2 px-4 py-3 text-[14px] font-medium text-ink hover:bg-white/[0.05]">The full story</a>
          <a href="results.html" className="rounded-xl px-3 py-3 text-[14px] font-medium text-ink-2 hover:text-ink">Results</a>
        </div>
        <p className="mt-5 flex items-center gap-2 font-mono text-[11px] text-ink-4">
          <motion.span animate={{ y: [0, 3, 0] }} transition={{ duration: 1.6, repeat: Infinity }}>↓</motion.span>
          {beat < beats.length - 1 ? 'Scroll to continue' : 'Scroll to start the demo'}
        </p>
      </div>
    </motion.aside>
  );
}

/** The landing's top bar: just the wordmark and the way out to the other pages. */
export function LandingBar() {
  return (
    <motion.header initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.8, ease }}
      className="absolute left-3 right-3 top-3 z-20 flex h-12 items-center gap-6 px-3">
      <a href="./" className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-accent text-[17px] font-bold text-bg">Ω</span>
        <span className="text-[16px] font-semibold tracking-tight">Nexus</span>
      </a>
      <nav className="ml-auto flex items-center gap-1 text-[13.5px]">
        <a href="about.html" className="rounded-lg px-3 py-1.5 text-ink-2 hover:bg-white/[0.05] hover:text-ink">About</a>
        <a href="results.html" className="rounded-lg px-3 py-1.5 text-ink-2 hover:bg-white/[0.05] hover:text-ink">Results</a>
      </nav>
    </motion.header>
  );
}

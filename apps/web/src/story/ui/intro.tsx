// The landing intro: a short brief on the left while the live 3D world plays behind it.
// Three beats, one per scroll; each beat moves the backdrop to the room it talks about.
// Scrolling past the last beat (or "Watch the demo") hands over to the story.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../../lib/api';
import { HBars } from '../../site/charts';
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

type Total = { success: number; total: number; false_verified: number };

/** The brief's numbers, read from the results API: BFCL per serving profile and the scoreboard batches. */
function useStats() {
  const [s, setS] = useState<{ healthy?: number; broken?: number; fvBefore?: number; fvAfter?: number; nBefore?: number; nAfter?: number;
    rules?: Total; after?: Total }>({});
  useEffect(() => {
    api.bfcl().then((p) => setS((x) => ({
      ...x,
      healthy: p.find((q) => q.label.endsWith('tools-template'))?.tool_calling_score,
      broken: p.find((q) => q.label.endsWith('vllm-32926'))?.tool_calling_score,
    }))).catch(() => {});
    api.scoreboard().then((b) => {
      const t = (id: string) => b.batches.find((x) => x.id === id)?.total;
      const sum = (ids: string[], k: 'false_verified' | 'total') => ids.reduce((n, id) => n + (t(id)?.[k] ?? 0), 0);
      const before = ['agent-batch1', 'agent-v1-before', 'agent-v2-before'], after = ['agent-known-after', 'agent-v1-after', 'agent-v2-after'];
      setS((x) => ({
        ...x, fvBefore: sum(before, 'false_verified'), nBefore: sum(before, 'total'), fvAfter: sum(after, 'false_verified'), nAfter: sum(after, 'total'),
        rules: t('rules-heldout'), after: t('agent-v1-after'),
      }));
    }).catch(() => {});
  }, []);
  return s;
}

const Chip = ({ children }: { children: ReactNode }) => (
  <span className="rounded-md border border-line-2 bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-ink-2"><span className="mr-1 text-ok">✓</span>{children}</span>
);

const FLOW = [
  ['Look around', 'typed tools: probes, config, metrics, logs'],
  ['Propose one fix', 'from a menu of moves that code builds'],
  ['Policy check', 'blocked unless allowed and safe'],
  ['Apply it', 'drain, change, test, and undo on failure'],
  ['Referee decides', 'independent of the model'],
] as const;

export function IntroPanel({ beat, onBeat, onStart }: { beat: number; onBeat: (i: number) => void; onStart: () => void }) {
  const st = useStats();
  const frac = (t?: Total) => (t ? `${t.success}/${t.total}` : '–');
  const beats: { title: string; body: string; visual?: ReactNode; caption?: string }[] = [
    {
      title: 'Dashboards say fine. The AI stopped working.',
      body: 'One wrong vLLM setting and the server keeps answering, fast, with every health check green, while the tool calls AI agents depend on are gone. No alert fires.',
      visual: (
        <div>
          <div className="flex flex-wrap gap-1.5"><Chip>HTTP 200</Chip><Chip>/health OK</Chip><Chip>latency normal</Chip></div>
          <div className="mt-5">
            <HBars compact bars={[
              { key: 'h', label: 'Tool calling, healthy server', value: st.healthy ?? 0, max: 1, display: st.healthy !== undefined ? st.healthy.toFixed(2) : '–', tone: 'ok' },
              { key: 'b', label: 'Same model, one setting wrong', value: st.broken ?? 0, max: 1, display: st.broken !== undefined ? st.broken.toFixed(2) : '–', tone: 'bad', sub: 'BFCL tool-calling score, 200 cases' },
            ]} />
          </div>
        </div>
      ),
      caption: 'Behind this panel: a real 2-worker vLLM fleet on one H100, replaying a recorded run.',
    },
    {
      title: 'A small model investigates. Code decides what counts.',
      body: 'NVIDIA Nemotron 3.5 Lightning (3B active) runs on the same GPU it repairs and proposes one fix. Everything after that is code it can’t talk its way past.',
      visual: (
        <ol className="grid gap-px overflow-hidden rounded-xl border border-line bg-line">
          {FLOW.map(([t, d], i) => (
            <li key={t} className={`flex items-baseline gap-3 px-4 py-2.5 ${i === FLOW.length - 1 ? 'bg-accent/[0.08]' : 'bg-[rgb(9_11_13/0.9)]'}`}>
              <span className="font-mono text-[11px] text-ink-4">{i + 1}</span>
              <span className={`text-[14px] font-medium ${i === FLOW.length - 1 ? 'text-accent' : 'text-ink'}`}>{t}</span>
              <span className="ml-auto text-right text-[11.5px] text-ink-3">{d}</span>
            </li>
          ))}
        </ol>
      ),
    },
    {
      title: 'Trustworthy enough to touch production.',
      body: 'Out of the box it sometimes said “fixed” when nothing was. We redesigned the harness around it, not the model.',
      visual: (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
          <div className="bg-[rgb(9_11_13/0.9)] p-4">
            <div className="text-[11.5px] leading-snug text-ink-3">False “fixed” claims</div>
            <div className="mt-2 text-[28px] font-semibold leading-none tracking-tight tnum">
              <span className="text-bad">{st.fvBefore ?? '–'}</span><span className="mx-1.5 text-[20px] text-ink-4">→</span><span className="text-ok">{st.fvAfter ?? '–'}</span>
            </div>
            <div className="mt-2 text-[11.5px] text-ink-3">before → after, {st.nAfter ?? '–'} runs each</div>
          </div>
          <div className="bg-[rgb(9_11_13/0.9)] p-4">
            <div className="text-[11.5px] leading-snug text-ink-3">Faults nobody wrote rules for</div>
            <div className="mt-2 text-[28px] font-semibold leading-none tracking-tight tnum text-ink">{frac(st.after)}</div>
            <div className="mt-2 text-[11.5px] text-ink-3">solved. Rules: {frac(st.rules)}</div>
          </div>
        </div>
      ),
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
      className="absolute bottom-3 left-3 top-[72px] z-20 flex flex-col justify-between overflow-y-auto rounded-2xl border border-white/[0.07] bg-[rgb(9_11_13/0.72)] p-7 backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [@media(max-height:820px)]:p-6"
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
          <motion.div key={beat} custom={dir} variants={slide} initial="enter" animate="center" exit="exit" className="mt-8 [@media(max-height:820px)]:mt-5">
            <div className="font-mono text-[12px] text-accent">0{beat + 1}</div>
            <h1 className="mt-3 text-[32px] font-semibold [@media(max-height:820px)]:text-[28px] leading-[1.06] tracking-[-0.02em]" style={{ textWrap: 'balance' }}>{b.title}</h1>
            <p className="mt-4 text-[15px] leading-relaxed text-ink-2">{b.body}</p>
            {b.visual && <div className="mt-6 [@media(max-height:820px)]:mt-5">{b.visual}</div>}
            {b.caption && <p className="mt-6 font-mono text-[11.5px] leading-relaxed text-ink-3">{b.caption}</p>}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="mt-8 [@media(max-height:820px)]:mt-5">
        <div className="flex flex-wrap gap-2">
          <button onClick={onStart} className="rounded-xl bg-accent px-5 py-3 text-[15px] font-semibold text-bg">Watch the demo ▸</button>
          <a href="results.html" className="rounded-xl border border-line-2 px-4 py-3 text-[14px] font-medium text-ink hover:bg-white/[0.05]">See the results</a>
          <a href="about.html" className="rounded-xl px-3 py-3 text-[14px] font-medium text-ink-2 hover:text-ink">About</a>
        </div>
        <p className="mt-5 flex items-center gap-2 font-mono text-[11px] text-ink-4 [@media(max-height:820px)]:mt-3">
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

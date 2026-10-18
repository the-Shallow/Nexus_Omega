// Plays a story on the world: enters hops, schedules beats, advances on a timer,
// pauses at an approval, and keeps the URL deep-linkable (?story=…|?run=…, &hop=N, &shot).
import { useCallback, useEffect, useState } from 'react';
import { crah } from './script/crah';
import { silent } from './script/silent';
import { snapshotAt, type Story } from './script/types';
import type { World } from './world/world';

export const STORIES: Story[] = [silent, crah];

const params = new URLSearchParams(location.search);
/** Review mode for screenshots: instant camera, beats applied at once, paused. */
export const SHOT = params.has('shot');
/** The hop to open on first load, from ?hop=N. Later stories start at 0. */
const firstHop = Math.max(0, Number(params.get('hop')) || 0);

export function useDirector(world: World | null, story: Story) {
  // Story and hop live together so a new story never plays a stale hop index, even for a frame.
  const [pos, setPos] = useState({ story, hop: Math.min(firstHop, story.hops.length - 1) });
  const [playing, setPlaying] = useState(!SHOT);
  if (pos.story !== story) {
    // The same story loaded again (e.g. a re-fetched run) keeps its place; a different one starts over.
    const same = pos.story.id === story.id;
    setPos({ story, hop: same ? pos.hop : 0 });
    if (!same) setPlaying(!SHOT);
  }
  const hop = pos.story.id === story.id ? Math.min(pos.hop, story.hops.length - 1) : 0;
  const setHop = useCallback((next: (i: number) => number) => setPos((p) => ({ ...p, hop: next(p.hop) })), []);
  const [speed, setSpeed] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const h = story.hops[hop];
  /** The room on screen, which a beat can change mid-hop (a camera cut). */
  const [room, setRoom] = useState(h.room);

  // Enter the hop: set every block to where the story is, then play this hop's beats.
  useEffect(() => {
    if (!world) return;
    world.clearTimers();
    world.configureTwin(story.candidates);
    const snap = snapshotAt(story, hop);
    world.apply(snap.blocks);
    if (h.set) world.apply(h.set);
    world.light({ ...snap.paths, ...h.paths });
    world.finale(h.finale ?? null, SHOT);
    if (!h.finale) world.setFog(h.cam === 'wide' ? 30 : 18, h.cam === 'wide' ? 80 : 52);
    world.focus(h.room);
    setRoom(h.room);
    setWaiting(!!h.wait);
    if (SHOT) {
      let cam = h.cam;
      for (const b of h.beats ?? []) {
        if (b.set) world.apply(b.set);
        if (b.cam) cam = b.cam;
        if (b.focus) { world.focus(b.focus); setRoom(b.focus); }
        // Transient effects that leave a mark (naming a tool, filling cards) still run.
        if (!b.cam) b.fx?.(world);
      }
      world.cam(cam, 0);
      world.stage.warm(4);
      return;
    }
    world.cam(h.cam, hop === 0 ? 3.2 : h.finale ? 3.6 : 2.4);
    for (const b of h.beats ?? []) {
      world.after(b.at / speed, () => {
        if (b.set) world.apply(b.set);
        if (b.cam) world.cam(b.cam, 1.8);
        if (b.focus) { world.focus(b.focus); setRoom(b.focus); }
        b.fx?.(world);
      });
    }
    const url = new URL(location.href);
    url.searchParams.delete('story');
    url.searchParams.delete('run');
    if (story.mode === 'real') url.searchParams.set('run', story.short);
    else url.searchParams.set('story', story.id);
    url.searchParams.set('hop', String(hop));
    history.replaceState(null, '', url);
    // Speed is read once per hop on purpose; a change applies from the next hop.
  }, [world, story, hop]);

  // Advance after the hop's duration, unless paused, waiting for approval, or at the end.
  useEffect(() => {
    if (!world || !playing || SHOT || waiting || hop >= story.hops.length - 1) return;
    const t = setTimeout(() => setHop((i) => i + 1), (h.dur * 1000) / speed);
    return () => clearTimeout(t);
  }, [world, story, hop, playing, speed, waiting, h.dur, setHop]);

  const go = useCallback((i: number) => setHop(() => Math.min(Math.max(0, i), story.hops.length - 1)), [story, setHop]);
  const approve = useCallback(() => {
    if (!world || !h.wait) return;
    world.apply(h.wait.set);
    setWaiting(false);
    setPlaying(true);
  }, [world, h]);
  const restart = useCallback(() => { setHop(() => 0); setPlaying(true); }, [setHop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowRight') go(hop + 1);
      else if (e.key === 'ArrowLeft') go(hop - 1);
      else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, hop]);

  return { hop, h, room, playing, setPlaying, speed, setSpeed, waiting, approve, go, restart };
}

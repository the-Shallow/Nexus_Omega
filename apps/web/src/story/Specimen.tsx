// Block specimen: every block type on three plinths (healthy / in between / broken),
// so shapes can be judged before any story is scripted. ?specimen=<id> deep-links.
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import * as THREE from 'three';
import { Stage } from './engine/stage';
import { basic, glow, label, mesh, metal } from './engine/fx';
import { FAMILIES, makeBlock, type Block } from './blocks';
import { TONE } from './blocks/types';

const ease = [0.16, 1, 0.3, 1] as const;
// ?shot places the camera instantly, for review screenshots.
const SHOT = new URLSearchParams(location.search).has('shot');

function initial() {
  const id = new URLSearchParams(location.search).get('specimen');
  return Math.max(0, FAMILIES.findIndex((f) => f.id === id));
}

export default function Specimen() {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [index, setIndex] = useState(initial);
  const fam = FAMILIES[index];

  useEffect(() => {
    const s = new Stage(host.current!, { floor: [40, 24], fade: 16, camera: { pos: [0, 4, 12], target: [0, 1, 0] } });
    s.setFocusInset(0.11, SHOT);
    stage.current = s;
    (window as unknown as { story: unknown }).story = { stage: s };
    return () => s.dispose();
  }, []);

  useEffect(() => {
    const s = stage.current!;
    const group = new THREE.Group();
    const blocks: Block[] = [];
    fam.states.forEach((st, k) => {
      const x = (k - 1) * fam.spacing;
      const tone = TONE[st.tone];
      const plinth = mesh(new THREE.CylinderGeometry(1.25, 1.32, 0.08, 64), metal(0x0c0f12, 0.5, 0.5), [x, -0.04, 0]);
      const rim = mesh(new THREE.TorusGeometry(1.26, 0.008, 8, 96), basic(tone, 1.3), [x, 0.002, 0], false);
      rim.rotation.x = Math.PI / 2;
      const cap = label(`<b>${st.label}</b><span>${st.note}</span>`, `lbl story-cap tone-${st.tone}`, [x, -0.05, 1.7]);
      group.add(plinth, rim, cap);
      const b = makeBlock(fam, st.key);
      b.root.position.set(x, 0, 0);
      group.add(b.root);
      blocks.push(b);
    });
    s.scene.add(group);
    const tick = (t: number, dt: number) => {
      blocks.forEach((b, k) => {
        b.root.rotation.y = fam.yaw + (SHOT ? 0 : Math.sin(t * 0.22 + k * 0.6) * 0.28);
        b.tick(t, dt);
      });
    };
    s.tickers.add(tick);
    if (SHOT) s.warm(4);
    const dist = fam.spacing * 2.3 + 4.2;
    s.flyTo([0, fam.y + dist * fam.lift, dist], [0, fam.y, 0], SHOT ? 0 : 1.4);
    const url = new URL(location.href);
    url.searchParams.set('specimen', fam.id);
    history.replaceState(null, '', url);
    return () => {
      s.tickers.delete(tick);
      s.scene.remove(group);
      group.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); if ((o as unknown as { element?: HTMLElement }).element) (o as unknown as { element: HTMLElement }).element.remove(); });
    };
  }, [fam]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') setIndex((i) => (i + 1) % FAMILIES.length);
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') setIndex((i) => (i - 1 + FAMILIES.length) % FAMILIES.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0">
      <div ref={host} className="absolute inset-0" />
      <motion.aside
        initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7, ease }}
        className="glass absolute left-4 top-4 bottom-4 w-[300px] rounded-2xl p-3 flex flex-col"
      >
        <div className="px-2 pt-1 pb-3">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-accent text-[15px] font-bold text-bg">Ω</span>
            <span className="font-semibold">Block specimen</span>
          </div>
          <p className="mt-2 text-[12.5px] leading-snug text-ink-3">One look per kind of thing. Each block shown healthy, in between, and broken. ↑ ↓ to browse.</p>
        </div>
        <div className="flex-1 overflow-y-auto pr-1">
          {FAMILIES.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setIndex(i)}
              className={`w-full text-left rounded-xl px-3 py-2 transition-colors ${i === index ? 'bg-white/[0.07]' : 'hover:bg-white/[0.035]'}`}
            >
              <div className="flex items-center gap-2">
                <span className="label w-5 !text-ink-4">{String(i + 1).padStart(2, '0')}</span>
                <span className={`text-[13.5px] font-medium ${i === index ? 'text-ink' : 'text-ink-2'}`}>{f.name}</span>
                <span className="ml-auto flex gap-1">
                  {f.states.map((s) => <i key={s.key} className="size-1.5 rounded-full" style={{ background: '#' + glow(TONE[s.tone], 1).getHexString() }} />)}
                </span>
              </div>
              {i === index && <p className="mt-1 pl-7 text-[12px] leading-snug text-ink-3">{f.stands}</p>}
            </button>
          ))}
        </div>
        <div className="label px-2 pt-3">SIMULATED · visual mockup</div>
      </motion.aside>
      <motion.div
        key={fam.id}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}
        className="pointer-events-none absolute right-8 top-7 text-right"
      >
        <div className="label">{String(index + 1).padStart(2, '0')} / {FAMILIES.length}</div>
        <div className="mt-1 text-[28px] font-semibold tracking-tight">{fam.name}</div>
      </motion.div>
    </div>
  );
}

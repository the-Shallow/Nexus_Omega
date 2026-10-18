import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { datacenter } from '../domains';
import { twin } from '../lib/bus';
import { setClockBase } from '../lib/format';
import { store, useStore } from '../lib/store';

export interface TwinLayout { zoom: number; shift: number; lift?: number; dim: number; standby: boolean }

/** Full-bleed digital twin. Frames go straight from the socket to the scene; layout eases inside the scene. */
export function TwinCanvas({ layout }: { layout: TwinLayout }) {
  const host = useRef<HTMLDivElement>(null);
  const topo = useStore((s) => s.topo);
  const hasFrame = useStore((s) => s.frame !== null);

  useEffect(() => {
    if (!topo || !host.current || !datacenter.createScene) return;
    setClockBase(topo.clock_base_s);
    const scene = datacenter.createScene(host.current, topo);
    twin.set(scene);
    const last = store.get().frame;
    if (last) scene.update(last);
    let lastMode = store.get().mode;
    const off = store.onFrame((f, mode) => {
      if (mode !== lastMode) { scene.clearFlows(); lastMode = mode; }
      scene.update(f);
    });
    return () => { off(); twin.set(null); scene.dispose(); };
  }, [topo]);

  useEffect(() => twin.subscribe((scene) => scene?.setLayout({ zoom: layout.zoom, shift: layout.shift, lift: layout.lift ?? 0 })), [layout.zoom, layout.shift, layout.lift]);

  // Standby (a real-fleet replay owns the stage): the twin recedes but stays visible.
  const filter = layout.standby ? 'saturate(0.25) brightness(0.42) blur(1.5px)' : `saturate(${1 - layout.dim * 0.3}) brightness(${1 - layout.dim * 0.4}) blur(0px)`;
  return (
    <motion.div
      ref={host}
      className="absolute inset-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: hasFrame ? 1 : 0, filter }}
      transition={{ opacity: { duration: 2.4, ease: [0.16, 1, 0.3, 1] }, filter: { duration: 1.2, ease: [0.16, 1, 0.3, 1] } }}
    />
  );
}

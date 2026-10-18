import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { datacenter } from '../domains';
import { twin } from '../lib/bus';
import { setClockBase } from '../lib/format';
import { store, useStore } from '../lib/store';

/** Full-bleed digital twin. Frames go straight from the socket to the scene. */
export function TwinCanvas() {
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

  return (
    <motion.div
      ref={host}
      className="absolute inset-0"
      initial={{ opacity: 0, scale: 1.04 }}
      animate={{ opacity: hasFrame ? 1 : 0, scale: hasFrame ? 1 : 1.04 }}
      transition={{ duration: 2.2, ease: [0.16, 1, 0.3, 1] }}
    />
  );
}

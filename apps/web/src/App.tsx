import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BreakOverlay } from './components/BreakOverlay';
import { Header } from './components/Header';
import { OutcomeSheet } from './components/Outcome';
import { Inspector, ReplayBar, Toasts, Vitals } from './components/Overlays';
import { Approval, Panels } from './components/Panels';
import { RecoveryTimeline } from './components/RecoveryTimeline';
import { TwinCanvas } from './components/TwinCanvas';
import { WhatIf } from './components/WhatIf';
import { api } from './lib/api';
import { toast, twin } from './lib/bus';
import { store, useStore } from './lib/store';

export default function App() {
  const run = useStore((s) => s.doctor);
  const mode = useStore((s) => s.mode);
  const connected = useStore((s) => s.connected);
  const [breakOpen, setBreakOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const closeOutcome = useCallback(() => setOutcomeOpen(false), []);
  useDirector(setOutcomeOpen);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea') || breakOpen || outcomeOpen) return;
      if (e.key === 'b' || e.key === 'B') setBreakOpen(true);
      else if (e.key === 'o' || e.key === 'O') twin.get()?.home();
      else if (e.key === ' ') {
        e.preventDefault();
        const s = store.get();
        if (s.replay) store.setReplay({ playing: !s.replay.playing });
        else api.control({ paused: !s.frame?.paused });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [breakOpen, outcomeOpen]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <TwinCanvas />
      {/* Edge falloff keeps the eye on the hall and the glass legible. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_45%,transparent_55%,rgba(4,6,7,0.85))]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/50 to-transparent" />

      <Header onBreak={() => setBreakOpen(true)} />
      <Vitals />
      <Panels run={run} />
      <RecoveryTimeline run={run} onOutcome={() => setOutcomeOpen(true)} />
      <AnimatePresence>
        {run?.awaiting_approval && mode !== 'replay' && (
          <motion.div
            initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0 }}
            className="glass pointer-events-auto absolute bottom-[150px] left-1/2 z-30 w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl p-3"
          >
            <Approval run={run} />
          </motion.div>
        )}
      </AnimatePresence>
      <Inspector />
      <ReplayBar />
      <Toasts />
      <AnimatePresence>
        {!connected && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-[60] grid place-items-center">
            <div className="text-center">
              <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-white/10 border-t-accent" />
              <p className="text-[14px] text-ink-2">Connecting to the digital twin…</p>
              <p className="mt-1 font-mono text-[11px] text-ink-4">./scripts/twin.sh serves it on :8765</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <WhatIf />
      <BreakOverlay open={breakOpen} onClose={() => setBreakOpen(false)} />
      <OutcomeSheet open={outcomeOpen} run={run} onClose={closeOutcome} />
    </div>
  );
}

/**
 * Camera and reveal choreography, driven by the run's real state changes:
 * engage → incident framing; VERIFIED → restoration wave, camera home, proof;
 * any other terminal state → proof without the celebration.
 */
function useDirector(setOutcomeOpen: (open: boolean) => void) {
  const run = useStore((s) => s.doctor);
  const mode = useStore((s) => s.mode);
  const seenRun = useRef<string | null>(null);
  const seenEnd = useRef<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    // Entering or leaving a replay restarts the choreography for that recording.
    seenRun.current = null;
    seenEnd.current = null;
    setOutcomeOpen(false);
  }, [mode === 'replay']); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const scene = twin.get();
    if (!run) { setOutcomeOpen(false); return; }
    const endKey = run.terminal ? `${run.id}:${run.terminal}` : null;
    if (run.id !== seenRun.current) {
      const firstSight = seenRun.current === null && store.get().mode !== 'replay' && !!run.terminal;
      seenRun.current = run.id;
      if (firstSight) { seenEnd.current = endKey; return; } // page opened after this run ended
      if (!run.terminal) {
        if (scene) scene.incident = true;
        toast(`${run.title} engaged`, 'info', 3000);
      }
    }
    if (endKey && endKey !== seenEnd.current) {
      seenEnd.current = endKey;
      if (scene) scene.incident = false;
      if (run.terminal === 'VERIFIED') {
        scene?.recoveryWave();
        timers.current.push(window.setTimeout(() => twin.get()?.home(), 2600));
      }
      timers.current.push(window.setTimeout(() => setOutcomeOpen(true), run.terminal === 'VERIFIED' ? 3400 : 2000));
    }
  }, [run?.id, run?.terminal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Panels and the timeline take the right and bottom edges while a run is on screen.
  useEffect(() => twin.subscribe((scene) => scene?.setFocusInset(run ? 0.09 : 0)), [!!run]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
}

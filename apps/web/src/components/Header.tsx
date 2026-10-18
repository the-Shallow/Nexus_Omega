import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../lib/api';
import { toast, twin } from '../lib/bus';
import { clock } from '../lib/format';
import { store, useStore } from '../lib/store';
import { systemStatus, TONE_BG, TONE_TEXT } from '../lib/status';
import type { DataMode } from '../lib/types';

const SPEEDS = [1, 4, 10];

export function Header({ onBreak }: { onBreak: () => void }) {
  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 1, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="glass pointer-events-auto absolute left-4 right-4 top-4 z-30 flex h-14 items-center gap-3 rounded-2xl pl-4 pr-2 md:left-6 md:right-6"
    >
      <Brand />
      <Divider />
      <ModeIndicator />
      <Status />
      <div className="ml-auto flex items-center gap-2">
        <SimClock />
        <Menu />
        <BreakButton onClick={onBreak} />
      </div>
    </motion.header>
  );
}

const Divider = () => <span className="hidden h-6 w-px bg-line md:block" />;

function Brand() {
  return (
    <div className="flex items-center gap-2.5 pr-1">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <defs>
          <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9be22d" />
            <stop offset="1" stopColor="#4d7c0f" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill="#0d1113" stroke="rgb(255 255 255 / .08)" />
        <path d="M10.2 22.6h3.6v-1.9a6.2 6.2 0 1 1 4.4 0v1.9h3.6" fill="none" stroke="url(#brand-g)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[0.18em]">NEXUS<span className="ml-1.5 text-accent">Ω</span></span>
    </div>
  );
}

const MODES: { id: DataMode; label: string; tip: string }[] = [
  { id: 'live', label: 'Live', tip: 'Production telemetry. Not connected to this view yet.' },
  { id: 'simulated', label: 'Simulated', tip: 'Streaming from the SimPy digital twin (uncalibrated profile).' },
  { id: 'replay', label: 'Replay', tip: 'Playing back a recorded incident.' },
];

function ModeIndicator() {
  const mode = useStore((s) => s.mode);
  const connected = useStore((s) => s.connected);
  return (
    <div className="hidden items-center rounded-xl bg-black/30 p-0.5 lg:flex" role="status" aria-label={`Data source: ${mode}`}>
      {MODES.map((m) => {
        const on = m.id === mode && connected;
        const dot = m.id === 'live' ? 'bg-ok' : m.id === 'simulated' ? 'bg-info' : 'bg-replay';
        return (
          <span key={m.id} title={m.tip} className={`relative flex items-center gap-1.5 rounded-[10px] px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.12em] ${on ? 'text-ink' : m.id === 'live' ? 'text-ink-4' : 'text-ink-3'}`}>
            {on && <motion.span layoutId="mode-pill" className="absolute inset-0 rounded-[10px] bg-white/[0.07]" transition={{ type: 'spring', stiffness: 400, damping: 34 }} />}
            <span className={`relative size-1.5 rounded-full ${on ? dot : 'bg-ink-4'}`} />
            <span className="relative">{m.label}</span>
          </span>
        );
      })}
    </div>
  );
}

function Status() {
  const connected = useStore((s) => s.connected);
  const frame = useStore((s) => s.frame);
  const run = useStore((s) => s.doctor);
  const st = systemStatus(connected, frame, run);
  return (
    <div className="flex min-w-0 items-center gap-2.5 pl-1">
      <span className="relative flex size-2.5">
        {st.pulse && <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${TONE_BG[st.tone]}`} />}
        <span className={`relative size-2.5 rounded-full ${TONE_BG[st.tone]}`} />
      </span>
      <div className="hidden min-w-0 flex-col leading-tight sm:flex">
        <span className="label !text-[9.5px]">System status</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={st.label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
            className={`truncate text-[13px] font-medium ${TONE_TEXT[st.tone]}`}
          >
            {st.label}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

function SimClock() {
  const t = useStore((s) => s.frame?.t ?? 0);
  const paused = useStore((s) => s.frame?.paused ?? false);
  const speed = useStore((s) => s.frame?.speed ?? 1);
  const replay = useStore((s) => s.replay);
  const isReplay = !!replay;
  const playing = isReplay ? replay.playing : !paused;
  const curSpeed = isReplay ? replay.speed : speed;
  const toggle = () => (isReplay ? store.setReplay({ playing: !replay.playing }) : api.control({ paused: !paused }));
  const setSpeed = (s: number) => (isReplay ? store.setReplay({ speed: s, playing: true }) : api.control({ speed: s, paused: false }));
  return (
    <div className="flex items-center gap-1 rounded-xl bg-black/30 py-1 pl-3 pr-1">
      <div className="mr-1.5 hidden flex-col leading-tight sm:flex">
        <span className={`label !text-[9.5px] ${isReplay ? '!text-replay' : ''}`}>{isReplay ? 'Replay time' : 'Simulation time'}</span>
        <span className="tnum font-mono text-[13px] text-ink">{clock(t)}</span>
      </div>
      <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="grid size-8 place-items-center rounded-lg text-ink-2 transition hover:bg-white/5 hover:text-ink">
        {playing ? (
          <svg viewBox="0 0 24 24" className="size-3.5 fill-current"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" className="size-3.5 fill-current"><path d="M7 4.5v15l12.5-7.5z" /></svg>
        )}
      </button>
      <div className="relative hidden items-center md:flex">
        {(isReplay ? [1, 2, 4] : SPEEDS).map((s) => (
          <button key={s} onClick={() => setSpeed(s)} className={`relative h-8 w-9 rounded-lg font-mono text-[11px] transition ${curSpeed === s ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
            {curSpeed === s && <motion.span layoutId="speed-pill" className="absolute inset-0.5 rounded-md bg-white/[0.08]" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
            <span className="relative">{s}×</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Menu() {
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const autopilot = useStore((s) => s.autopilot);
  const recording = useStore((s) => s.recording);
  const replay = useStore((s) => s.replay);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setConfirmReset(false); return; }
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const reset = async () => {
    if (!confirmReset) return setConfirmReset(true);
    setOpen(false);
    if (store.get().replay) store.exitReplay();
    await api.control({ reset: true, speed: 1, paused: false });
    store.clearLiveDoctor();
    twin.get()?.home();
    toast('Twin reset to a healthy fleet');
  };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label="More" aria-expanded={open} className="grid size-10 place-items-center rounded-xl text-ink-2 transition hover:bg-white/5 hover:text-ink">
        <svg viewBox="0 0 24 24" className="size-4 fill-current"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className="glass-strong absolute right-0 top-12 w-72 origin-top-right rounded-2xl p-1.5 text-[13px]"
          >
            <button
              onClick={() => api.doctorConfig({ autopilot: !autopilot }).then(() => toast(autopilot ? 'Autopilot off: doctors wait for your authorization before acting' : 'Autopilot on: doctors act within policy'))}
              className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left hover:bg-white/5"
            >
              <span><span className="block text-ink">Autopilot</span><span className="text-[11.5px] text-ink-3">Act within policy without asking</span></span>
              <span className={`relative h-5 w-9 rounded-full transition ${autopilot ? 'bg-accent' : 'bg-white/10'}`}>
                <motion.span layout className={`absolute top-0.5 size-4 rounded-full bg-white ${autopilot ? 'right-0.5' : 'left-0.5'}`} />
              </span>
            </button>
            <button onClick={() => { twin.get()?.home(); setOpen(false); }} className="flex w-full rounded-xl px-3 py-2.5 text-left text-ink hover:bg-white/5">Overview camera</button>
            <button
              disabled={!recording || !!replay}
              onClick={() => { store.startReplay(); setOpen(false); }}
              className="flex w-full flex-col rounded-xl px-3 py-2.5 text-left text-ink hover:bg-white/5 disabled:cursor-default disabled:text-ink-4 disabled:hover:bg-transparent"
            >
              Replay last incident
              <span className="text-[11.5px] text-ink-3">{recording ? recording.label : 'Nothing recorded yet'}</span>
            </button>
            <div className="my-1 h-px bg-line" />
            <button onClick={reset} className={`flex w-full rounded-xl px-3 py-2.5 text-left hover:bg-white/5 ${confirmReset ? 'text-bad' : 'text-ink'}`}>
              {confirmReset ? 'Click again to reset the twin' : 'Reset twin'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BreakButton({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      className="group relative flex h-10 items-center gap-2 overflow-hidden rounded-xl border border-bad/40 bg-bad/10 pl-3 pr-4 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#ffd1d8] shadow-[0_0_24px_-8px_rgba(244,63,94,0.7)] transition-colors hover:border-bad/70 hover:bg-bad/20"
    >
      <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
      <svg viewBox="0 0 24 24" className="relative size-4 fill-bad drop-shadow-[0_0_6px_rgba(244,63,94,0.9)]"><path d="M13.2 2 4.5 13.6h6.3L9.9 22l8.6-11.6h-6.2z" /></svg>
      <span className="relative hidden sm:inline">Break the system</span>
      <span className="relative sm:hidden">Break</span>
    </motion.button>
  );
}

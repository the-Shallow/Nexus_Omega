import { motion, useReducedMotion } from 'framer-motion';
import { useId } from 'react';

// The NEXUS Ω mark: an open orbit (the omega's arc) standing on a horizon line, with a
// single signal travelling along it. Open at the bottom, closed by nothing: a loop
// that watches, acts and lets the evidence back in.
const ARC = 'M11.76 21.28A8 8 0 1 1 20.24 21.28';
const FEET = 'M11.76 21.28Q10.7 23.7 6.6 23.7M20.24 21.28Q21.3 23.7 25.4 23.7';

export function OmegaMark({ size = 30, draw = false, orbit = true, className = '' }: { size?: number; draw?: boolean; orbit?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  const reduce = useReducedMotion();
  const animateDraw = draw && !reduce;
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden>
      <defs>
        <linearGradient id={`og-${id}`} x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#c6f36b" />
          <stop offset="0.55" stopColor="#76b900" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
        <radialGradient id={`oc-${id}`}>
          <stop offset="0" stopColor="#d9ff9e" stopOpacity="0.9" />
          <stop offset="1" stopColor="#76b900" stopOpacity="0" />
        </radialGradient>
      </defs>
      <motion.path
        d={ARC} fill="none" stroke={`url(#og-${id})`} strokeWidth="1.9" strokeLinecap="round"
        initial={animateDraw ? { pathLength: 0, opacity: 0 } : false}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.3, ease: [0.65, 0, 0.35, 1] }}
      />
      <motion.path
        d={FEET} fill="none" stroke={`url(#og-${id})`} strokeWidth="1.9" strokeLinecap="round"
        initial={animateDraw ? { pathLength: 0, opacity: 0 } : false}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.6, delay: animateDraw ? 1.05 : 0, ease: [0.65, 0, 0.35, 1] }}
      />
      <circle cx="16" cy="14.5" r="2.2" fill={`url(#oc-${id})`} opacity="0.55" />
      {orbit && !reduce ? (
        <circle r="1.55" fill="#eaffc4">
          <animateMotion dur="7s" repeatCount="indefinite" path={ARC} keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />
        </circle>
      ) : (
        <circle cx="16" cy="6.5" r="1.55" fill="#eaffc4" />
      )}
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`display select-none whitespace-nowrap text-[13px] font-medium tracking-[0.28em] text-ink ${className}`}>
      NEXUS
    </span>
  );
}

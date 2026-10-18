// The narration, where the eye already is: each step's sentence as a large caption at
// the bottom of the scene, revealed word by word, with the things that matter colored
// by what they mean. The tech line sits small underneath.
import { motion } from 'framer-motion';
import type { Hop } from '../script/types';
import { ACTS } from '../script/types';

const ease = [0.16, 1, 0.3, 1] as const;

/** Highlight rules, first match wins at each position. Colors follow the state palette. */
const RULES: [RegExp, string][] = [
  [/FALSE VERIFIED/, 'font-semibold text-bad'],
  [/\bVERIFIED\b/, 'font-semibold text-ok'],
  [/\b(?:failing|crashed|caught|broken|tripped|struggling)\b/i, 'text-bad'],
  [/200 OK|no tool calls?|tool calls are gone|0 tool calls|empty|quietly/i, 'text-warn'],
  [/\b(?:target-[ab]|vllm-\d|CRAH-\d)\b/, 'font-medium text-ink underline decoration-accent/70 decoration-2 underline-offset-[6px]'],
];

function segments(text: string): { t: string; cls?: string }[] {
  const out: { t: string; cls?: string }[] = [];
  let rest = text;
  while (rest) {
    let best: { i: number; len: number; cls: string } | null = null;
    for (const [re, cls] of RULES) {
      const m = re.exec(rest);
      if (m && (best === null || m.index < best.i)) best = { i: m.index, len: m[0].length, cls };
    }
    if (!best) { out.push({ t: rest }); break; }
    if (best.i > 0) out.push({ t: rest.slice(0, best.i) });
    out.push({ t: rest.slice(best.i, best.i + best.len), cls: best.cls });
    rest = rest.slice(best.i + best.len);
  }
  return out;
}

export function Caption({ h, act, engineer, waiting, onApprove, left }: {
  h: Hop; act: 1 | 2 | 3; engineer: boolean; waiting: boolean; onApprove: () => void; left: number;
}) {
  // Split into words so each one can arrive in turn, keeping highlight classes per word.
  let n = 0;
  const words = segments(h.plain).flatMap((s) => s.t.split(/(\s+)/).filter(Boolean).map((w) => ({ w, cls: s.cls, i: /\s/.test(w) ? -1 : n++ })));
  const size = h.plain.length > 170 ? 'text-[20px]' : h.plain.length > 110 ? 'text-[23px]' : 'text-[26px]';
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-[40vh] bg-gradient-to-t from-bg/90 via-bg/45 to-transparent" />
      <div className="pointer-events-none absolute bottom-[74px] right-4 z-10 flex justify-center" style={{ left }}>
        <motion.div key={h.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="max-w-[860px] text-center">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.2em] text-accent">Act {act} · {ACTS[act - 1].title} <span className="text-ink-3">· {h.title}</span></div>
          <p className={`mt-2.5 font-medium leading-[1.3] tracking-[-0.01em] text-ink/95 ${size}`} style={{ textWrap: 'balance' }}>
            {words.map((x, k) => x.i < 0 ? <span key={k}>{x.w}</span> : (
              <motion.span key={k} className={`inline-block ${x.cls ?? ''}`} initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.5, ease, delay: 0.15 + x.i * 0.035 }}>{x.w}</motion.span>
            ))}
          </p>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.4 + n * 0.035 }}
            className="mt-2.5 font-mono text-[11.5px] text-ink-3">{h.tech}</motion.p>
          {engineer && h.engineer && (
            <ul className="mx-auto mt-2 max-w-[720px] space-y-0.5 text-left">
              {h.engineer.slice(0, 4).map((l) => <li key={l} className="truncate font-mono text-[11px] text-ink-3">{l}</li>)}
            </ul>
          )}
          {h.wait && waiting && (
            <button onClick={onApprove} className="pointer-events-auto mt-4 inline-flex items-center gap-2 rounded-xl bg-warn px-4 py-2.5 text-[14px] font-semibold text-bg">
              <span className="size-2 animate-pulse rounded-full bg-bg" />{h.wait.label}
            </button>
          )}
        </motion.div>
      </div>
    </>
  );
}

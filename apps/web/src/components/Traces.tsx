import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';
import { nodeForResource, type ArchId, type ArchModel } from '../lib/arch';
import { arch, twin } from '../lib/bus';

interface Link { key: string; resource: string; node: ArchId; color: string; toTwin: boolean; strength: number }

/**
 * Thin signal traces between the hall on the left and the architecture on the
 * right: where the failure sits, and what the current tool call or repair is
 * touching. Restrained on purpose: at most three at once.
 */
export function Traces({ model, faultTargets, active }: { model: ArchModel | null; faultTargets: string[]; active: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  const reduce = !!useReducedMotion();
  const links = useRef<Link[]>([]);

  const out: Link[] = [];
  if (active && model) {
    const seen = new Set<ArchId>();
    for (const r of faultTargets) {
      const node = nodeForResource(r);
      // Only while the failure is still in place there.
      if (!node || seen.has(node) || model.nodes.find((n) => n.id === node)?.state !== 'fault') continue;
      seen.add(node);
      out.push({ key: `fault:${r}`, resource: r, node, color: '#f43f5e', toTwin: false, strength: 0.55 });
      if (seen.size >= 2) break;
    }
    const t = model.touching;
    if (t && model.nodes.some((n) => n.id === t.from)) out.push({ key: `touch:${t.from}:${t.resource}`, resource: t.resource.split(',')[0].trim(), node: t.from, color: t.kind === 'act' ? '#c6f36b' : '#7fd6ff', toTwin: true, strength: 0.9 });
  }
  links.current = out;

  useEffect(() => {
    let raf = 0, t0 = performance.now();
    const loop = (now: number) => {
      const el = svg.current;
      const scene = twin.get(), board = arch.get(), host = arch.host();
      if (el) {
        const rect = host?.getBoundingClientRect();
        const groups = el.querySelectorAll<SVGGElement>('g[data-k]');
        groups.forEach((g) => {
          const l = links.current.find((x) => x.key === g.dataset.k);
          const ent = l && scene?.resolve(l.resource);
          const a = ent && scene ? scene.screenPos(ent) : null;
          const b = l && board && rect ? board.screenPos(l.node) : null;
          const path = g.querySelector('path')!, dot = g.querySelector('circle')!;
          if (!l || !a || !b || !rect || !a.visible || !b.visible) { g.style.opacity = '0'; return; }
          const x1 = a.x, y1 = a.y, x2 = rect.left + b.x, y2 = rect.top + b.y;
          const dx = x2 - x1;
          path.setAttribute('d', `M${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx * 0.42).toFixed(1)} ${(y1 - 70).toFixed(1)}, ${(x2 - dx * 0.38).toFixed(1)} ${(y2 - 30).toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`);
          g.style.opacity = String(l.strength);
          const len = path.getTotalLength();
          const ph = reduce ? 0.5 : (((now - t0) / 1000) / (l.toTwin ? 1.4 : 2.6)) % 1;
          const p = path.getPointAtLength((l.toTwin ? 1 - ph : ph) * len);
          dot.setAttribute('cx', p.x.toFixed(1));
          dot.setAttribute('cy', p.y.toFixed(1));
          dot.style.opacity = String(Math.sin(ph * Math.PI));
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); t0 = 0; };
  }, [reduce]);

  return (
    <svg ref={svg} className="pointer-events-none absolute inset-0 z-[21] h-full w-full" aria-hidden>
      <defs>
        <filter id="trace-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2" /></filter>
      </defs>
      {out.map((l) => (
        <g key={l.key} data-k={l.key} style={{ opacity: 0, transition: 'opacity .6s' }}>
          <path fill="none" stroke={l.color} strokeOpacity="0.5" strokeWidth="1.1" strokeDasharray="1.5 5" strokeLinecap="round" />
          <circle r="3" fill={l.color} style={{ filter: `drop-shadow(0 0 7px ${l.color})` }} />
        </g>
      ))}
    </svg>
  );
}

// Nexus side: a doctor console, the shadow twin, the policy gate and the certificate.
import * as THREE from 'three';
import { STATUS } from '../../twin/palette';
import { additive, basic, canvasTex, curve, glow, holo, label, mesh, metal, Sparks, Travelers } from '../engine/fx';
import type { Block } from './types';

const SIM = 0xa78bfa;
const HEX = (n: number) => '#' + n.toString(16).padStart(6, '0');

/**
 * A doctor: a dais with a core that thinks, tool glyphs that orbit while it
 * investigates (each firing a beam at what it inspects), and evidence cards that
 * stack up once it has a conclusion.
 */
export interface Doctor extends Block {
  /** Name the tool call in progress; null goes back to the idle orbit of default tools. */
  say(tool: string | null): void;
  /** Replace the evidence cards shown once the doctor concludes. */
  setCards(texts: string[]): void;
}

/** Wrap text into at most `lines` lines that fit `width` pixels, ending in … if cut. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, lines: number) {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= width) { cur = next; continue; }
    out.push(cur);
    cur = w;
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && out.join(' ').length < text.length) out[lines - 1] = out[lines - 1].replace(/.{0,2}$/, '…');
  return out;
}

export function doctor(name = 'Tool-Calling Doctor', tools = ['get_change_history', 'read_raw_generation', 'read_serving_config', 'run_canary']): Doctor {
  const root = new THREE.Group();
  const dais = mesh(new THREE.CylinderGeometry(0.85, 0.92, 0.14, 48), metal(0x0f1316, 0.6, 0.45), [0, 0.07, 0]);
  const rim = mesh(new THREE.TorusGeometry(0.86, 0.012, 8, 72), basic(STATUS.ok, 1.2), [0, 0.142, 0], false);
  rim.rotation.x = Math.PI / 2;
  const pillar = mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.8, 16), metal(0x1b2228), [0, 0.54, 0]);
  const core = mesh(new THREE.IcosahedronGeometry(0.22, 0), basic(STATUS.ok, 1.8), [0, 1.18, 0], false);
  const shell = mesh(new THREE.IcosahedronGeometry(0.3, 1), new THREE.MeshBasicMaterial({ color: glow(STATUS.ok, 0.8), wireframe: true, transparent: true, opacity: 0.35 }), [0, 1.18, 0], false);
  const halo = mesh(new THREE.TorusGeometry(0.5, 0.01, 8, 64), basic(STATUS.ok, 1.4), [0, 1.18, 0], false);
  root.add(dais, rim, pillar, core, shell, halo);
  root.add(label(`<b>${name}</b><span class="m">rule-based stand-in</span>`, 'lbl unit', [0, 2.05, 0]));

  const glyphs = tools.map((tool, k) => {
    const g = new THREE.Group();
    const m = mesh(new THREE.OctahedronGeometry(0.07, 0), basic(STATUS.ok, 2), undefined, false);
    const tag = label(tool, 'lbl story-tool');
    tag.position.y = 0.16;
    g.add(m, tag);
    g.userData.phase = (k / tools.length) * Math.PI * 2;
    root.add(g);
    return { g, m, tag };
  });
  // The beam from the core to whatever the current tool inspects.
  const beamTarget = new THREE.Vector3(1.6, 0.6, 0.5);
  const beam = mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), additive(STATUS.ok, 0.9, 2.2), undefined, false);
  root.add(beam);
  const hit = mesh(new THREE.SphereGeometry(0.06, 12, 8), basic(STATUS.ok, 2.4), beamTarget.toArray() as [number, number, number], false);
  root.add(hit);

  const drawCard = (ctx: CanvasRenderingContext2D, tex: THREE.CanvasTexture, txt: string, k: number) => {
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = 'rgba(14,18,20,0.92)'; ctx.beginPath(); ctx.roundRect(2, 2, 508, 124, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(118,185,0,0.55)'; ctx.lineWidth = 3; ctx.stroke();
    ctx.font = '600 20px "JetBrains Mono", monospace'; ctx.fillStyle = '#76b900'; ctx.fillText(`EVIDENCE ${k + 1}`, 26, 36);
    ctx.font = '500 25px "Instrument Sans Variable", sans-serif'; ctx.fillStyle = '#e9eef1';
    wrap(ctx, txt, 460, 2).forEach((l, i) => ctx.fillText(l, 26, 74 + i * 32));
    tex.needsUpdate = true;
  };
  let cardText = ['change 0.27.1 → 0.28.0 · 40 min ago', 'raw output: tool JSON in text', 'parser hermes ≠ template'];
  const cards = cardText.map((txt, k) => {
    const { ctx, tex } = canvasTex(512, 128);
    drawCard(ctx, tex, txt, k);
    const card = mesh(new THREE.PlaneGeometry(1.0, 0.25), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide }), [-1.25, 0.75 + k * 0.32, 0.2], false);
    card.rotation.y = 0.35;
    card.userData = { ctx, tex };
    root.add(card);
    return card;
  });
  document.fonts?.ready.then(() => cards.forEach((c, k) => drawCard(c.userData.ctx, c.userData.tex, cardText[k] ?? '', k)));
  let spoken: string | null = null;
  const _a = new THREE.Vector3(), _mid = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

  const b: Doctor = {
    root, state: 'idle',
    set(s) { b.state = s; },
    say(tool) { spoken = tool; },
    setCards(texts) {
      cardText = texts.slice(0, cards.length);
      cards.forEach((c, k) => { c.userData.hidden = k >= cardText.length; if (k < cardText.length) drawCard(c.userData.ctx, c.userData.tex, cardText[k], k); });
    },
    tick(t, dt) {
      const s = b.state;
      const on = s !== 'idle';
      const c = on ? STATUS.ok : STATUS.off;
      core.material.color.copy(glow(c, s === 'investigate' ? 1.6 + 0.8 * Math.sin(t * 5) : on ? 2 : 0.6));
      shell.material.color.copy(glow(c, 0.8));
      halo.material.color.copy(glow(c, on ? 1.4 : 0.5));
      rim.material.color.copy(glow(c, on ? 1.2 : 0.4));
      core.rotation.y += dt * (s === 'investigate' ? 1.6 : 0.3);
      shell.rotation.y -= dt * 0.4;
      halo.rotation.set(Math.PI / 2 + Math.sin(t * 0.7) * 0.4, t * 0.5, 0);
      glyphs.forEach(({ g, m, tag }, k) => {
        const a = g.userData.phase + t * (s === 'investigate' ? 0.9 : 0.15);
        const r = s === 'conclude' ? 0.62 : 0.78;
        g.position.set(Math.cos(a) * r, 1.18 + Math.sin(a * 2) * 0.08, Math.sin(a) * r);
        g.visible = on;
        // With a named tool call in progress, glyph 0 carries it and the rest stay quiet.
        const active = s === 'investigate' && (spoken !== null ? k === 0 : Math.floor(t / 1.1) % glyphs.length === k);
        m.material.color.copy(glow(STATUS.ok, active ? 3 : 1.2));
        tag.element.dataset.on = active ? '1' : '';
        tag.element.textContent = spoken !== null && k === 0 ? spoken : tools[k];
        tag.visible = s === 'investigate' && (spoken === null || k === 0);
      });
      const firing = s === 'investigate' && (t % 1.1) < 0.7;
      beam.visible = hit.visible = firing;
      if (firing) {
        _a.set(0, 1.18, 0);
        _mid.copy(_a).add(beamTarget).multiplyScalar(0.5);
        beam.position.copy(_mid);
        beam.scale.set(1, _a.distanceTo(beamTarget), 1);
        beam.quaternion.setFromUnitVectors(_up, _a.sub(beamTarget).normalize().negate());
        beam.material.opacity = 0.5 + 0.4 * Math.sin(t * 30);
      }
      cards.forEach((card, k) => {
        const show = s === 'conclude' && !card.userData.hidden;
        const target = show ? 1 : 0;
        card.scale.y += (target - card.scale.y) * (1 - Math.exp(-dt * (4 + k)));
        card.visible = card.scale.y > 0.02;
        card.position.y = 0.75 + k * 0.32 + Math.sin(t * 1.2 + k) * 0.015;
      });
    },
  };
  return b;
}

/**
 * The shadow twin: a violet hologram copy of the serving floor where candidate fixes
 * race. Each candidate is a lane with three seed runs; the spread between seeds is
 * drawn as a band so uncertainty is visible.
 */
export interface Candidate { name: string; fate: 'win' | 'policy' | 'lose' }
export interface Twin extends Block { configure(c: Candidate[]): void }

export function shadowTwin(candidates: Candidate[] = [
  { name: 'A · patch parser only', fate: 'policy' },
  { name: 'B · parser + template, 2 at a time', fate: 'win' },
  { name: 'C · restart replicas', fate: 'lose' },
]): Twin {
  const root = new THREE.Group();
  const grid = new THREE.GridHelper(3.2, 16, glow(SIM, 0.6), glow(SIM, 0.25));
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  grid.position.y = 0.01;
  root.add(grid);
  const racks: ReturnType<typeof holo>[] = [];
  for (let k = 0; k < 4; k++) {
    const h = holo(new THREE.BoxGeometry(0.36, 0.95, 0.44), SIM, 0.05);
    h.group.position.set(-1.2 + k * 0.42, 0.48, -1.0);
    root.add(h.group);
    racks.push(h);
  }
  const scan = mesh(new THREE.PlaneGeometry(1.9, 0.02), additive(SIM, 0.8, 2), [-0.57, 0.5, -0.77], false);
  root.add(scan);
  root.add(label('<b>Shadow twin</b><span class="m">fork of live state · 3 seeds each</span>', 'lbl unit', [-0.57, 1.45, -1.0]));

  const tr = new Travelers(120);
  root.add(tr.points);
  const lanes = candidates.map((c, k) => {
    const z = -0.3 + k * 0.62;
    const route = curve([[-1.4, 0.18, z], [0, 0.22, z], [1.35, 0.18, z]], 20);
    const r = tr.add(route);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(route.pts), new THREE.LineBasicMaterial({ color: glow(SIM, 0.8), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    const band = mesh(new THREE.PlaneGeometry(1, 0.22), additive(SIM, 0.12, 1), [0.85, 0.02, z], false);
    band.rotation.x = -Math.PI / 2;
    const finish = mesh(new THREE.BoxGeometry(0.03, 0.3, 0.3), basic(SIM, 1.4), [1.4, 0.16, z], false);
    const tag = label(c.name, 'lbl story-cand', [1.55, 0.3, z]);
    root.add(line, band, finish, tag);
    return { ...c, r, line, band, finish, tag, z };
  });
  let acc = 0;

  const b: Twin = {
    configure(c) {
      lanes.forEach((l, k) => { l.name = c[k].name; l.fate = c[k].fate; l.tag.element.textContent = c[k].name; });
    },
    root, state: 'fork',
    set(s) { b.state = s; tr.clear(); acc = 99; },
    tick(t, dt) {
      const s = b.state;
      const materialize = s === 'idle' ? 0.22 : s === 'fork' ? 0.4 + 0.6 * Math.abs(Math.sin(t * 2.4)) : 1;
      racks.forEach((h, k) => {
        (h.line.material as THREE.LineBasicMaterial).opacity = materialize * (0.6 + 0.3 * Math.sin(t * 3 + k));
        h.face.material.opacity = 0.05 * materialize;
      });
      scan.position.y = 0.05 + ((t * 0.5) % 1) * 0.9;
      acc += dt;
      if ((s === 'race' || s === 'winner') && acc > 1.6) {
        acc = 0;
        lanes.forEach((l) => {
          // Three seeds per candidate: same route, slightly different speeds.
          const base = l.fate === 'win' ? 0.95 : l.fate === 'policy' ? 1.1 : 1.45;
          for (let seed = 0; seed < 3; seed++) {
            const c = s === 'winner' ? (l.fate === 'win' ? STATUS.ok : l.fate === 'policy' ? STATUS.bad : STATUS.off) : SIM;
            tr.spawn(l.r, c, { dur: base * (0.9 + seed * 0.09), size: 0.08, gain: 2 });
          }
        });
      }
      lanes.forEach((l) => {
        const show = s === 'race' || s === 'winner';
        l.line.visible = l.band.visible = l.finish.visible = show;
        l.tag.visible = show;
        const c = s === 'winner' ? (l.fate === 'win' ? STATUS.ok : l.fate === 'policy' ? STATUS.bad : STATUS.off) : SIM;
        (l.line.material as THREE.LineBasicMaterial).color.copy(glow(c, s === 'winner' && l.fate === 'win' ? 1.6 : 0.8));
        l.band.material.color.copy(glow(c, 1));
        l.band.scale.x = l.fate === 'win' ? 0.35 : l.fate === 'policy' ? 0.6 : 0.9;
        l.finish.material.color.copy(glow(c, 1.6));
        l.tag.element.dataset.fate = s === 'winner' ? l.fate : '';
      });
      tr.update(dt);
    },
  };
  return b;
}

/** The policy gate: a scanner ring every repair must pass through before it touches anything real. */
export function gate(): Block {
  const root = new THREE.Group();
  const ring = mesh(new THREE.TorusGeometry(0.82, 0.06, 16, 80), metal(0x1b2228, 0.8, 0.3), [0, 1.0, 0]);
  const glowRing = mesh(new THREE.TorusGeometry(0.76, 0.012, 8, 80), basic(STATUS.ok, 2), [0, 1.0, 0], false);
  const disc = mesh(new THREE.CircleGeometry(0.74, 64), additive(STATUS.ok, 0.07), [0, 1.0, 0], false);
  const sweep = mesh(new THREE.PlaneGeometry(1.48, 0.02), additive(STATUS.ok, 0.9, 2), [0, 1.0, 0.002], false);
  const foot = mesh(new THREE.BoxGeometry(0.5, 0.2, 0.34), metal(0x0f1316), [0, 0.1, 0]);
  const neck = mesh(new THREE.BoxGeometry(0.12, 0.2, 0.12), metal(0x1b2228), [0, 0.26, 0]);
  for (const m of [ring, glowRing, disc, sweep]) m.rotation.y = Math.PI / 2;
  root.add(foot, neck, ring, glowRing, disc, sweep);
  const tag = label('', 'lbl wtag', [0, 2.05, 0]);
  root.add(tag);
  const tr = new Travelers(40);
  const sp = new Sparks(32);
  root.add(tr.points, sp.points);
  const r = tr.add([[-1.5, 1.0, 0], [1.5, 1.0, 0]]);
  let acc = 0, sparkAt = -1;
  const at = new THREE.Vector3(-0.15, 1.0, 0);
  const b: Block = {
    root, state: 'pass',
    set(s) {
      b.state = s;
      tag.visible = s !== 'idle';
      tag.element.className = 'lbl wtag ' + (s === 'blocked' ? 'bad' : s === 'await' ? 'warn' : '');
      tag.element.innerHTML = s === 'pass' ? '<b>policy</b><em>allow-listed · within budget</em>' : s === 'await' ? '<b>autopilot off</b><em>authorize?</em>' : '<b>policy</b><em>outside approved list</em>';
      tr.clear();
    },
    tick(t, dt) {
      const s = b.state;
      const c = s === 'idle' ? STATUS.off : s === 'pass' ? STATUS.ok : s === 'await' ? STATUS.warn : STATUS.bad;
      glowRing.material.color.copy(glow(c, s === 'await' ? 1.4 + Math.sin(t * 4) * 0.9 : 2));
      disc.material.color.copy(glow(c, 1));
      sweep.material.color.copy(glow(c, 2));
      sweep.position.y = 1.0 + Math.sin(t * 2.2) * 0.68;
      sweep.scale.x = Math.sqrt(Math.max(0, 1 - ((sweep.position.y - 1.0) / 0.74) ** 2));
      acc += dt;
      if (acc > 0.9 && s !== 'idle') {
        acc = 0;
        if (s === 'pass') tr.spawn(r, STATUS.ok, { dur: 1.4, size: 0.14, gain: 1.8 });
        else tr.spawn(r, s === 'await' ? STATUS.warn : STATUS.bad, { dur: 1.4, size: 0.14, gain: 1.8, until: 0.44 });
        if (s === 'blocked') sparkAt = t + 1.4 * 0.44;
      }
      if (sparkAt > 0 && t >= sparkAt) { sp.burst(at, STATUS.bad, 10); sparkAt = -1; }
      tr.update(dt);
      sp.update(dt);
    },
  };
  b.set('pass');
  return b;
}

export interface CertRecord { word: string; color: number; rows: [string, string][]; hash?: string[] }
export interface Cert extends Block { record(r: CertRecord): void }

const PRESETS: Record<string, CertRecord> = {
  verified: { word: 'VERIFIED', color: STATUS.ok, rows: [['incident', 'silent tool-call drop'], ['doctor', 'Tool-Calling'], ['detect', '00:41'], ['close', '03:12'], ['checks', '6 / 6 held 10 s']] },
  human: { word: 'NEEDS A HUMAN', color: STATUS.warn, rows: [['incident', 'CRAH-1 trip'], ['doctor', 'Infrastructure'], ['service', 'verified'], ['facility', 'CRAH-1 down'], ['next', 'field repair']] },
  rolled: { word: 'ROLLED BACK', color: STATUS.restart, rows: [['incident', 'replica stall'], ['doctor', 'Infrastructure'], ['checks', '3 / 6 failed'], ['rollback', 'tok-7f3a'], ['state', 'restored']] },
};

/** The recovery certificate: a slab with an engraved record and a seal ring. */
export function certificate(): Cert {
  const root = new THREE.Group();
  const slab = mesh(new THREE.BoxGeometry(1.1, 1.55, 0.08), new THREE.MeshStandardMaterial({ color: 0x0b0f12, metalness: 0.6, roughness: 0.25 }), [0, 1.05, 0]);
  const { ctx, tex } = canvasTex(440, 620);
  const face = mesh(new THREE.PlaneGeometry(1.04, 1.47), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }), [0, 1.05, 0.042], false);
  const base = mesh(new THREE.CylinderGeometry(0.5, 0.56, 0.12, 40), metal(0x0f1316), [0, 0.06, 0]);
  const beam = mesh(new THREE.CylinderGeometry(0.42, 0.5, 2.2, 40, 1, true), additive(STATUS.ok, 0.05), [0, 1.1, 0], false);
  const seal = mesh(new THREE.TorusGeometry(0.2, 0.014, 8, 64), basic(STATUS.ok, 2.2), [0.33, 0.52, 0.12], false);
  const seal2 = mesh(new THREE.TorusGeometry(0.16, 0.006, 8, 64), basic(STATUS.ok, 1.6), [0.33, 0.52, 0.12], false);
  root.add(base, slab, face, beam, seal, seal2);

  let current: CertRecord = PRESETS.verified;
  const draw = (r: CertRecord) => {
    current = r;
    const col = r.color, word = r.word, rows = r.rows;
    ctx.clearRect(0, 0, 440, 620);
    ctx.font = '600 20px "JetBrains Mono", monospace'; ctx.fillStyle = '#6b7880';
    ctx.fillText('RECOVERY CERTIFICATE', 34, 60);
    ctx.font = '600 42px "Instrument Sans Variable", sans-serif'; ctx.fillStyle = HEX(col);
    ctx.fillText(word, 34, 120);
    ctx.font = '500 22px "JetBrains Mono", monospace';
    rows.forEach(([k, v], i) => {
      ctx.fillStyle = '#48535a'; ctx.fillText(k, 34, 190 + i * 46);
      ctx.fillStyle = '#c9d3d9'; ctx.fillText(v, 170, 190 + i * 46);
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(34, 440); ctx.lineTo(406, 440); ctx.stroke();
    ctx.font = '500 17px "JetBrains Mono", monospace'; ctx.fillStyle = '#48535a';
    const hash = r.hash ?? ['sha256', '9f2c 41ab e07d 5c19 88e2 3fa0', 'b6d4 07c1 aa93 2e5f 71c8 d02e'];
    ctx.fillText(hash[0], 34, 476);
    ctx.fillStyle = '#6b7880';
    hash.slice(1).forEach((h, i) => ctx.fillText(h, 34, 504 + i * 26));
    tex.needsUpdate = true;
    seal.material.color.copy(glow(col, 2.2));
    seal2.material.color.copy(glow(col, 1.6));
    beam.material.color.copy(glow(col, 1));
  };
  const b: Cert = {
    root, state: 'verified',
    set(s) { b.state = s; draw(PRESETS[s] ?? PRESETS.verified); },
    record(r) { b.state = 'record'; draw(r); },
    tick(t) {
      seal.rotation.z = t * 0.6;
      seal2.rotation.z = -t * 0.9;
      beam.material.opacity = 0.04 + 0.02 * Math.sin(t * 2);
      slab.position.y = face.position.y = 1.05 + Math.sin(t * 1.1) * 0.02;
    },
  };
  // Fonts may land after the first draw.
  document.fonts?.ready.then(() => draw(current));
  b.set('verified');
  return b;
}

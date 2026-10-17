import { Twin3D } from './scene.js';
import { Hud, api } from './hud.js';

let scene = null;
let hud = null;

function connect(delay = 500) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'hello') {
      if (!scene) {
        scene = new Twin3D(document.getElementById('stage'), data.topology);
        hud = new Hud(data.topology, scene);
        bindControls();
      }
      for (const e of data.events) hud.logEvent(e);
      return;
    }
    if (!scene) return;
    scene.update(data);
    hud.update(data);
  };
  ws.onclose = () => setTimeout(() => connect(Math.min(delay * 2, 5000)), delay);
}

function toggle(name, on) {
  const btn = document.querySelector(`[data-toggle="${name}"]`);
  if (btn) btn.classList.toggle('on', on);
}

function bindControls() {
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => scene.preset(b.dataset.view)));
  const flip = {
    cinematic: () => scene.setCinematic(!scene.cinematic),
    thermal: () => { scene.setThermal(!scene.thermal); toggle('thermal', scene.thermal); },
    labels: () => {
      const on = !document.querySelector('[data-toggle="labels"]').classList.contains('on');
      scene.setLabels(on); toggle('labels', on);
    },
    focus: () => { hud.autoFocus = !hud.autoFocus; toggle('focus', hud.autoFocus); },
  };
  scene.listeners.cinematic = [(on) => toggle('cinematic', on)];
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => flip[b.dataset.toggle]()));
  document.querySelectorAll('#speed button').forEach((b) => b.addEventListener('click', () => {
    const speed = +b.dataset.speed;
    api('/api/control', speed === 0 ? { paused: true } : { speed, paused: false });
  }));

  const views = ['overview', 'cold', 'hot', 'plenum', 'top', 'power', 'network'];
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('hud-off');
    else if (e.key >= '1' && e.key <= '7') scene.preset(views[+e.key - 1]);
    else if (e.key === 'c' || e.key === 'C') flip.cinematic();
    else if (e.key === 't' || e.key === 'T') flip.thermal();
    else if (e.key === 'l' || e.key === 'L') flip.labels();
    else if (e.key === 'f' || e.key === 'F') flip.focus();
    else if (e.key === 'p' || e.key === 'P') hud.runPreview();
    else if (e.key === 'Escape') scene.select(null);
    else if (e.key === ' ') {
      e.preventDefault();
      api('/api/control', { paused: !hud.frame?.paused });
    } else return;
  });
}

connect();

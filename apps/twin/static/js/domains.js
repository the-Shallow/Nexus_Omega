// Domain modules. Only the AI datacenter is operational; the others are design
// specs that reuse the same observe → diagnose → simulate → act → verify loop.
import { esc } from './ui.js';

export const DOMAINS = [
  {
    id: 'datacenter',
    name: 'AI Datacenter',
    status: 'live',
    blurb: 'GPU inference fleet: vLLM replicas, racks, cooling and power.',
    color: '#76b900',
  },
  {
    id: 'healthcare',
    name: 'Healthcare',
    status: 'concept',
    color: '#0891b2',
    blurb: 'Hospital operations: departments, beds, staffing and patient flow.',
    assets: ['Emergency department', 'ICU and wards', 'Operating theatres', 'Imaging', 'Pharmacy', 'Patient transport'],
    tools: ['query_bed_census(unit)', 'read_staff_roster(unit, shift)', 'get_admission_queue()', 'simulate_diversion(policy)', 'open_surge_beds(unit, n) · approval', 'page_on_call(role) · approval'],
    rules: ['Never moves a patient: only proposes and pages humans', 'Any staffing or diversion change needs charge-nurse approval', 'Clinical data stays in the hospital boundary'],
    metrics: ['ED boarding time', 'Bed occupancy', 'Nurse-to-patient ratio', 'Time to theatre'],
    incident: 'Surge in ED arrivals; ICU at 96% occupancy',
    blocks: [[0, 0, 3, 2, 1.2, 'ED'], [3.4, 0, 2.4, 2, 2.2, 'ICU'], [0, 2.4, 2.2, 2.4, 1.6, 'Wards'], [2.6, 2.4, 1.8, 1.6, 1.0, 'Imaging'], [4.8, 2.4, 1.2, 1.6, 0.8, 'Pharmacy']],
  },
  {
    id: 'agriculture',
    name: 'Agriculture',
    status: 'concept',
    color: '#65a30d',
    blurb: 'Farms: fields, irrigation networks, weather and soil sensors.',
    assets: ['Field blocks', 'Pump stations', 'Irrigation lines', 'Soil moisture probes', 'Weather station', 'Storage'],
    tools: ['read_soil_moisture(block)', 'get_weather_forecast(hours)', 'read_pump_telemetry(station)', 'simulate_irrigation(schedule)', 'set_valve_schedule(block) · bounded', 'dispatch_technician(asset) · approval'],
    rules: ['Water budget per block cannot be exceeded', 'Valve changes are reversible and logged', 'Pesticide or harvest decisions are never automated'],
    metrics: ['Soil moisture vs target', 'Water use', 'Pump uptime', 'Crop stress index'],
    incident: 'Pump station 2 pressure drop; block C moisture falling',
    blocks: [[0, 0, 2.6, 2.6, 0.15, 'Block A'], [2.9, 0, 2.6, 2.6, 0.15, 'Block B'], [0, 2.9, 2.6, 2.6, 0.15, 'Block C'], [2.9, 2.9, 1.2, 1.2, 1.0, 'Pumps'], [4.4, 2.9, 1.1, 1.6, 1.4, 'Silo']],
  },
  {
    id: 'education',
    name: 'Education',
    status: 'concept',
    color: '#7c3aed',
    blurb: 'Campus: buildings, classrooms, schedules and shared resources.',
    assets: ['Lecture halls', 'Labs', 'Library', 'Network closets', 'HVAC zones', 'Exam schedule'],
    tools: ['get_room_schedule(building)', 'read_hvac_zone(zone)', 'read_network_health(building)', 'simulate_room_swap(plan)', 'reassign_room(class, room) · bounded', 'notify_students(class) · approval'],
    rules: ['Exams and accessibility needs are hard constraints', 'Room swaps only within the same building group', 'All notices are reviewed before sending'],
    metrics: ['Classes disrupted', 'Room utilization', 'Wi-Fi availability', 'Comfort index'],
    incident: 'HVAC failure in the science building during exam week',
    blocks: [[0, 0, 2.2, 2.2, 1.8, 'Science'], [2.6, 0, 3, 1.6, 1.2, 'Library'], [0, 2.6, 1.8, 3, 1.4, 'Halls'], [2.4, 2.4, 1.6, 1.6, 2.4, 'Admin'], [4.4, 2.4, 1.4, 2.8, 0.9, 'Labs']],
  },
  {
    id: 'logistics',
    name: 'Logistics',
    status: 'concept',
    color: '#d97706',
    blurb: 'Warehouses, delivery fleets, supply routes and fulfilment.',
    assets: ['Fulfilment centers', 'Dock doors', 'Sortation lines', 'Delivery fleet', 'Routes', 'Carrier APIs'],
    tools: ['get_order_backlog(site)', 'read_sorter_status(line)', 'get_fleet_positions()', 'simulate_reroute(plan)', 'shift_orders(site_a, site_b) · bounded', 'book_extra_carrier(lane) · approval'],
    rules: ['Promised delivery windows are the SLO', 'Spend above threshold needs approval', 'Driver hours limits are never exceeded'],
    metrics: ['Orders past SLA', 'Dock utilization', 'On-time delivery', 'Cost per parcel'],
    incident: 'Sortation line 3 down at the east hub; backlog growing',
    blocks: [[0, 0, 3.4, 2.2, 1.4, 'East hub'], [3.8, 0, 2, 2.2, 1.1, 'Docks'], [0, 2.6, 2.4, 2.4, 1.2, 'West hub'], [2.8, 2.6, 3, 0.6, 0.2, 'Route 9'], [2.8, 3.6, 1.2, 1.2, 0.6, 'Fleet']],
  },
];

// Isometric block illustration, generated from the module's block list.
function isoScene(d) {
  const S = 26;
  const iso = (x, y, z) => [(x * 1.35 - y * 1.35) * S * 0.866 + 260, (x * 1.35 + y * 1.35) * S * 0.5 - z * 0.7 * S + 110];
  const shade = (hex, k) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.min(255, Math.round(c + (255 - c) * k));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  };
  const blocks = [...d.blocks].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const poly = (pts, fill, cls = '') => `<polygon class="${cls}" points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fill}"/>`;
  const ground = [iso(-0.6, -0.6, 0), iso(6.6, -0.6, 0), iso(6.6, 6.2, 0), iso(-0.6, 6.2, 0)];
  let out = poly(ground, '#f4f6f8') + `<polygon points="${ground.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#e2e6eb"/>`;
  for (const [i, [x, y, w, h, z, label]] of blocks.entries()) {
    const top = [iso(x, y, z), iso(x + w, y, z), iso(x + w, y + h, z), iso(x, y + h, z)];
    const left = [iso(x, y + h, z), iso(x + w, y + h, z), iso(x + w, y + h, 0), iso(x, y + h, 0)];
    const right = [iso(x + w, y, z), iso(x + w, y + h, z), iso(x + w, y + h, 0), iso(x + w, y, 0)];
    const c = iso(x + w / 2, y + h / 2, z);
    out += `<g class="blk" style="animation-delay:${i * 90}ms">${poly(left, shade(d.color, 0.35))}${poly(right, shade(d.color, 0.15))}${poly(top, shade(d.color, 0.72))}
      <text x="${c[0]}" y="${c[1] - 8}">${esc(label)}</text></g>`;
  }
  const pulse = iso(blocks[0][0] + blocks[0][2] / 2, blocks[0][1] + blocks[0][3] / 2, blocks[0][4]);
  return `<svg viewBox="0 0 520 380" class="iso">${out}<circle class="iso-pulse" cx="${pulse[0]}" cy="${pulse[1]}" r="10" fill="${d.color}"/></svg>`;
}

export function renderDomain(el, id) {
  const d = DOMAINS.find((x) => x.id === id);
  const list = (items) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  const loop = ['Observe', 'Diagnose', 'Simulate', 'Act', 'Verify'];
  el.innerHTML = `<div class="domain">
    <div class="domain-hero">
      <div>
        <span class="pill warn">Concept module · not operational</span>
        <h1>${esc(d.name)}</h1>
        <p class="lead">${esc(d.blurb)} Same controller, same loop, a different tool collection and twin.</p>
        <div class="loop">${loop.map((s, i) => `<span style="--c:${d.color};animation-delay:${i * 120}ms">${s}</span>`).join('<i></i>')}</div>
        <div class="example"><span class="eyebrow">Example incident</span><p>${esc(d.incident)}</p></div>
      </div>
      ${isoScene(d)}
    </div>
    <div class="domain-grid">
      <div class="pcard"><span class="eyebrow">Twin assets</span>${list(d.assets)}</div>
      <div class="pcard"><span class="eyebrow">Infrastructure Doctor tools</span>${list(d.tools)}</div>
      <div class="pcard"><span class="eyebrow">Operational rules</span>${list(d.rules)}</div>
      <div class="pcard"><span class="eyebrow">Metrics & SLOs</span>${list(d.metrics)}</div>
    </div>
    <p class="note">What changes per domain: twin assets, tool schemas, policy rules and SLOs. What stays: the controller, state machine, evidence ledger, shadow-twin precheck, independent verification and the recovery certificate.</p>
  </div>`;
}

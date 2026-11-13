// Frontend de ParkSpot (SPA en JavaScript puro).
// Recibe el estado integrado del gateway en tiempo real (Server-Sent Events)
// y envía las reservas con una clave de idempotencia para poder reintentarlas sin duplicar.

// ── Iconos (SVG en línea) ─────────────────────────────────────────────────────
const P = {
  chevR: '<path d="m9 18 6-6-6-6"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  car: '<path d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.65 5H8.4a2 2 0 0 0-1.9 1.26L5 10 3 8"/><path d="M7 14h.01M17 14h.01"/><rect width="18" height="8" x="3" y="10" rx="2"/><path d="M5 18v2M19 18v2"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  cal: '<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  parking: '<rect width="16" height="16" x="4" y="4" rx="4"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  wifiOff: '<path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 2l20 20M5 12.86a10 10 0 0 1 5.17-2.69M19 12.86a10 10 0 0 0-2-1.52M2 8.82a15 15 0 0 1 4.18-2.64M22 8.82a15 15 0 0 0-11.29-3.76"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
};
const icon = (n, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24">${P[n]}</svg>`;

// ── Utilidades ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} km` : `${m} m`);
const fmtTime = (t) => new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDateLong = (t) => new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtWeekday = (t) => cap(new Date(t).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }));
const ago = (ms) => (ms == null ? '' : ms < 5000 ? 'ahora' : ms < 60000 ? `hace ${Math.round(ms / 1000)} s` : `hace ${Math.round(ms / 60000)} min`);

const storage = {
  get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
let userId = storage.get('ps.user', null);
if (!userId) { userId = `u-${uuid().slice(0, 8)}`; storage.set('ps.user', userId); }
const myReservations = () => storage.get('ps.reservations', []);
const saveReservation = (r) => storage.set('ps.reservations', [r, ...myReservations().filter((x) => x.code !== r.code)].slice(0, 20));

/** Cancela una reserva en el nodo dueño (vía gateway). Devuelve la reserva actualizada o null. */
async function cancelReservation(r) {
  try {
    const res = await fetch(`/api/lots/${r.lotId}/reservations/${encodeURIComponent(r.code)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Si el nodo ya la marcó como cancelada/expirada, sincronizamos la copia local.
      if (res.status === 409 && data.message) {
        const status = data.message.match(/está (\w+)/)?.[1];
        if (status) saveReservation({ ...r, status });
      }
      toast(esc(data.message || 'No se pudo cancelar la reserva.'), 'error');
      return null;
    }
    const updated = { ...r, status: data.status };
    saveReservation(updated);
    toast(`Reserva <b>${esc(r.code)}</b> cancelada. El espacio ${esc(r.spaceId)} volvió a estar disponible.`, 'ok');
    return updated;
  } catch {
    toast('Sin conexión con el sistema. Intenta de nuevo.', 'error');
    return null;
  }
}

/** Botón de cancelar con confirmación en dos pasos (sin diálogos nativos). */
function bindCancel(container, r, onDone) {
  const btn = container.querySelector('[data-cancel]');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const box = btn.parentElement;
    btn.outerHTML = `<div class="cancel-ask"><span>¿Cancelar la reserva del espacio <b>${esc(r.spaceId)}</b>?</span>
      <div><button class="btn btn-danger" data-yes>Sí, cancelar</button><button class="btn btn-outline" data-no>No</button></div></div>`;
    const ask = box.querySelector('.cancel-ask');
    ask.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    ask.querySelector('[data-no]').addEventListener('click', () => onDone(null));
    ask.querySelector('[data-yes]').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      ev.target.innerHTML = '<span class="spinner"></span> Cancelando…';
      onDone(await cancelReservation(r));
    });
  });
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${msg}</span>`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

const STATUS = {
  online: { badge: 'Información actualizada', legend: 'En línea', desc: 'Datos sincronizados en tiempo real' },
  intermittent: { badge: 'Posiblemente desactualizada', legend: 'Intermitente', desc: 'Los datos podrían haber cambiado' },
  offline: { badge: 'Sin conexión', legend: 'Sin conexión', desc: 'Sin datos recientes; reservas en pausa' },
};

// ── Estado de la app ──────────────────────────────────────────────────────────
const store = {
  view: null, lots: [], connected: false,
  detail: null, selected: null, arrival: null,
  submitting: false, pending: null, uncertain: false,
};
const $app = document.getElementById('app');

// ── Tiempo real (SSE) ─────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false); // EventSource se reconecta solo
  es.addEventListener('lots', (e) => {
    store.lots = JSON.parse(e.data);
    if (store.view === 'home') updateHomeLive();
    if (store.view === 'results') renderResults();
    if (store.view === 'lot') updateLotStatus();
  });
  es.addEventListener('lot', (e) => {
    const d = JSON.parse(e.data);
    if (store.view === 'lot' && store.detail?.id === d.id && d.version >= (store.detail.version ?? 0)) {
      applySpaces(d.spaces, d.version);
    }
  });
}
function setConn(ok) {
  store.connected = ok;
  document.getElementById('conn').innerHTML = ok
    ? '<span class="dot online"></span>Conectado al sistema'
    : '<span class="dot offline"></span>Reconectando…';
}

// ── Router ────────────────────────────────────────────────────────────────────
function route() {
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] === 'estacionamientos' && parts[1]) return renderLot(parts[1].toUpperCase());
  if (parts[0] === 'estacionamientos') return renderResults();
  if (parts[0] === 'reserva' && parts[1]) return renderConfirm(decodeURIComponent(parts[1]));
  return renderHome();
}
window.addEventListener('hashchange', route);

// ── Vista: Inicio ─────────────────────────────────────────────────────────────
const PIN_POS = { UC: [24, 22], CC: [72, 36], HM: [40, 73] };
const PIN_COLOR = { blue: '#4353c9', violet: '#7a5bd6', amber: '#e0a458' };

function totalFree() {
  return store.lots.reduce((n, l) => n + (l.free ?? 0), 0);
}

function renderHome() {
  store.view = 'home';
  $app.innerHTML = `
  <div class="container">
    <section class="hero">
      <div>
        <div class="eyebrow">${icon('spark')} Movilidad inteligente</div>
        <h1>Estaciona fácil.<br><span>Llega tranquilo.</span></h1>
        <p class="lead">Encuentra y reserva espacios disponibles en tiempo real, antes de llegar a tu destino.</p>
        <div class="card loc-card">
          <div class="loc-icon">${icon('pin')}</div>
          <div><small>Tu ubicación</small><strong>Ubicación actual</strong><span class="sub">Av. Universidad, Ciudad</span></div>
          <span class="shield">${icon('shield')}</span>
        </div>
        <a class="btn btn-primary btn-lg" href="#/estacionamientos">Buscar estacionamientos ${icon('chevR')}</a>
        <div class="hero-meta"><span>${icon('route')} Cercanos a ti</span><span>${icon('clock')} Datos en tiempo real</span></div>
      </div>
      <div class="map-frame">
        <div class="map">
          <div class="road r1"></div><div class="road r2"></div><div class="road r3"></div>
          <div id="pins"></div>
          <div class="me"><i></i></div>
          <div class="map-chip"><span class="dot online" id="chip-dot"></span><span id="chip-text">Actualizado ahora</span></div>
          <div class="map-count">
            <div class="ic">${icon('car')}</div>
            <div><strong id="free-total">— espacios</strong><small>disponibles cerca</small></div>
          </div>
        </div>
      </div>
    </section>
  </div>
  <section class="stats">
    <div class="container">
      <div class="stat"><strong>3 min</strong><span>para encontrar lugar</span></div>
      <div class="stat"><strong>98%</strong><span>de datos confiables</span></div>
      <div class="stat"><strong>24/7</strong><span>disponibilidad</span></div>
    </div>
  </section>
  <div class="container" id="my-res"></div>`;
  updateHomeLive();
  renderMyReservations();
}

function updateHomeLive() {
  const pins = document.getElementById('pins');
  if (!pins) return;
  pins.innerHTML = store.lots.map((l) => {
    const [x, y] = PIN_POS[l.id] || [50, 50];
    return `<a class="pin ${l.status === 'offline' ? 'off' : ''}" href="#/estacionamientos/${l.id}" style="left:${x}%;top:${y}%;--c:${PIN_COLOR[l.color] || '#4353c9'}"
      title="${esc(l.name)} · ${l.free ?? 'sin datos'} libres">${icon('parking')}<span class="pin-status dot ${l.status}"></span></a>`;
  }).join('');
  document.getElementById('free-total').textContent = `${totalFree()} espacios`;
  const anyDegraded = store.lots.some((l) => l.status !== 'online');
  document.getElementById('chip-dot').className = `dot ${anyDegraded ? 'intermittent' : 'online'}`;
  document.getElementById('chip-text').textContent = anyDegraded ? 'Algunos datos con retraso' : 'Actualizado ahora';
}

function renderMyReservations() {
  const el = document.getElementById('my-res');
  const list = myReservations().filter((r) => r.status === 'activa' && r.arrivalTime + 15 * 60_000 > Date.now());
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<section class="my-res"><h2>Mis reservas</h2><div class="res-list">${list.map((r) => `
    <div class="card res-item" data-code="${esc(r.code)}">
      <a href="#/reserva/${encodeURIComponent(r.code)}" class="res-link">
        <span class="code">${esc(r.code)}</span>
        <span>${esc(r.lotName)} · Espacio <b>${esc(r.spaceId)}</b></span>
        <small>${fmtWeekday(r.arrivalTime)} · ${fmtTime(r.arrivalTime)}</small>
      </a>
      <div class="res-actions"><button class="btn btn-danger-outline" data-cancel>${icon('x')} Cancelar reserva</button></div>
    </div>`).join('')}</div></section>`;
  el.querySelectorAll('.res-item').forEach((card) => {
    const r = list.find((x) => x.code === card.dataset.code);
    bindCancel(card, r, () => renderMyReservations());
  });
}

// ── Vista: Resultados ─────────────────────────────────────────────────────────
function renderResults() {
  store.view = 'results';
  const lots = store.lots;
  const found = lots.filter((l) => l.status !== 'offline').length;
  $app.innerHTML = `
  <div class="container page">
    <a class="back" href="#/">${icon('chevL')} Inicio</a>
    <div class="page-head">
      <div>
        <div class="eyebrow">Resultados cercanos</div>
        <h1>Estacionamientos disponibles</h1>
        <p>${lots.length ? `${lots.length} estacionamientos encontrados cerca de tu ubicación${found < lots.length ? ` · ${lots.length - found} sin conexión` : ''}` : 'Buscando estacionamientos…'}</p>
      </div>
      <div class="legend">
        <span><i class="dot online"></i>En línea</span>
        <span><i class="dot intermittent"></i>Intermitente</span>
        <span><i class="dot offline"></i>Sin conexión</span>
      </div>
    </div>
    <div class="results">
      <div class="lot-list">${lots.map(lotCard).join('') || '<div class="card empty">Cargando…</div>'}</div>
      <aside class="card side">
        <div class="ic">${icon('shield')}</div>
        <h3>Datos transparentes</h3>
        <p>Te mostramos el estado de conexión para que sepas qué tan reciente es la información.</p>
        ${['online', 'intermittent', 'offline'].map((s) => `
          <div class="state-row"><strong><i class="dot ${s}"></i>${STATUS[s].legend}</strong><small>${STATUS[s].desc}</small></div>`).join('')}
      </aside>
    </div>
  </div>`;
}

function lotCard(l) {
  const freeText = l.status === 'offline'
    ? 'Sin datos recientes'
    : `${l.status === 'intermittent' ? '~' : ''}${l.free} espacios libres`;
  const action = l.reservable
    ? `<a class="btn btn-outline" href="#/estacionamientos/${l.id}">Ver espacios ${icon('chevR')}</a>`
    : '<span class="unavailable">Reserva no disponible</span>';
  return `
  <div class="card lot ${l.recommended ? 'recommended' : ''}">
    ${l.recommended ? '<span class="tag">RECOMENDADO</span>' : ''}
    <div class="avatar ${l.color}">${l.id}</div>
    <div class="lot-body">
      <h3>${esc(l.name)}</h3>
      <span class="badge ${l.status}"><i class="dot ${l.status}"></i>${STATUS[l.status].badge}</span>
      <div class="lot-meta">
        <span>${icon('car')} ${freeText}</span>
        <span>${icon('route')} ${fmtDist(l.distanceM)}</span>
        ${l.status !== 'online' && l.dataAgeMs != null ? `<span class="age">Último dato ${ago(l.dataAgeMs)}</span>` : ''}
      </div>
    </div>
    ${action}
  </div>`;
}

// ── Vista: Elegir espacio y reservar ──────────────────────────────────────────
function arrivalSlots() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
  return Array.from({ length: 12 }, (_, i) => d.getTime() + i * 15 * 60_000);
}

async function renderLot(id) {
  store.view = 'lot';
  store.selected = null;
  store.uncertain = false;
  store.pending = null;
  store.arrival = arrivalSlots()[1];
  store.detail = null;
  const meta = store.lots.find((l) => l.id === id);
  $app.innerHTML = `
  <div class="container page">
    <a class="back" href="#/estacionamientos">${icon('chevL')} Estacionamientos</a>
    <div class="lot-head">
      <div class="avatar ${meta?.color || 'blue'}">${esc(id)}</div>
      <div>
        <div class="eyebrow">Reserva de espacio</div>
        <h1 id="lot-name">${esc(meta?.name || 'Cargando…')}</h1>
        <div class="addr">${icon('pin')} <span id="lot-addr">${meta ? `${esc(meta.access)} · ${fmtDist(meta.distanceM)}` : ''}</span></div>
      </div>
    </div>
    <div id="lot-banner"></div>
    <div class="reserve">
      <section class="card picker" id="picker"><div class="empty">Consultando al estacionamiento…</div></section>
      <aside class="card summary" id="summary"></aside>
    </div>
  </div>`;
  renderSummary();
  try {
    const r = await fetch(`/api/lots/${id}`);
    if (!r.ok) throw new Error();
    const d = await r.json();
    if (store.view !== 'lot') return;
    store.detail = d;
    document.getElementById('lot-name').textContent = d.name;
    document.getElementById('lot-addr').textContent = `${d.access} · ${fmtDist(d.distanceM)}`;
    renderPicker();
    updateLotStatus();
    renderSummary();
  } catch {
    document.getElementById('picker').innerHTML = `<div class="empty">${icon('wifiOff')}<p>No se pudo cargar el estacionamiento.</p></div>`;
  }
}

function freeCount() {
  return store.detail?.spaces.filter((s) => s.status === 'libre').length ?? 0;
}

function renderPicker() {
  const d = store.detail;
  const el = document.getElementById('picker');
  if (!el || !d) return;
  if (!d.spaces.length) {
    el.innerHTML = `<div class="empty">${icon('wifiOff')}<p><b>Sin datos recientes.</b><br>El estacionamiento perdió conectividad. Las reservas se reactivarán cuando vuelva a conectarse.</p></div>`;
    return;
  }
  const byAisle = d.aisles.map((a) => [a, d.spaces.filter((s) => s.aisle === a)]);
  el.innerHTML = `
    <div class="picker-head">
      <div><h2>Elige tu espacio</h2><p>Selecciona uno de los espacios disponibles</p></div>
      <div class="free-pill"><b id="free-n">${freeCount()}</b> libres</div>
    </div>
    <div class="legend-row">
      <span><i class="sq free"></i>Disponible</span><span><i class="sq sel"></i>Seleccionado</span><span><i class="sq occ"></i>Ocupado</span>
    </div>
    ${byAisle.map(([a, spaces]) => `
      <div class="aisle-label">PASILLO ${esc(a)}</div>
      <div class="grid">${spaces.map(spaceTile).join('')}</div>`).join('')}`;
  el.querySelectorAll('.space').forEach((b) => b.addEventListener('click', () => selectSpace(b.dataset.id)));
}

function spaceTile(s) {
  const sel = store.selected === s.id;
  const label = s.status === 'libre' ? 'Libre' : s.status === 'reservado' ? 'Reservado' : 'Ocupado';
  return `<button class="space ${sel ? 'selected' : ''}" data-id="${esc(s.id)}" id="sp-${esc(s.id)}" ${s.status !== 'libre' ? 'disabled' : ''}>
    ${icon('car')}<b>${esc(s.id)}</b><small>${label}</small></button>`;
}

function selectSpace(id) {
  store.selected = store.selected === id ? null : id;
  store.uncertain = false;
  document.querySelectorAll('.space.selected').forEach((b) => b.classList.remove('selected'));
  if (store.selected) document.getElementById(`sp-${id}`)?.classList.add('selected');
  renderSummary();
}

/** Aplica una actualización en vivo del nodo sin redibujar toda la vista. */
function applySpaces(spaces, version) {
  const d = store.detail;
  const prev = Object.fromEntries(d.spaces.map((s) => [s.id, s.status]));
  d.spaces = spaces;
  d.version = version;
  if (!document.querySelector('#picker .grid')) { renderPicker(); return; }
  for (const s of spaces) {
    if (prev[s.id] === s.status) continue;
    const btn = document.getElementById(`sp-${s.id}`);
    if (!btn) continue;
    const tmp = document.createElement('div');
    tmp.innerHTML = spaceTile(s);
    const nb = tmp.firstElementChild;
    nb.classList.add('flash');
    nb.addEventListener('click', () => selectSpace(s.id));
    btn.replaceWith(nb);
    if (store.selected === s.id && s.status !== 'libre' && !store.submitting) {
      store.selected = null;
      toast(`El espacio <b>${esc(s.id)}</b> acaba de ser ocupado. Elige otro.`, 'error');
      renderSummary();
    }
  }
  const n = document.getElementById('free-n');
  if (n) n.textContent = freeCount();
}

function updateLotStatus() {
  const d = store.detail;
  if (!d) return;
  const l = store.lots.find((x) => x.id === d.id);
  if (!l) return;
  const wasOffline = d.status === 'offline';
  d.status = l.status;
  d.reservable = l.reservable;
  const b = document.getElementById('lot-banner');
  if (b) {
    b.innerHTML = l.status === 'intermittent'
      ? `<div class="banner warn">${icon('alert')}<div><b>Conexión intermitente con este estacionamiento.</b> La disponibilidad podría haber cambiado (último dato ${ago(l.dataAgeMs)}). Tu reserva se valida directamente con el estacionamiento, así que nunca se asignará un espacio ya ocupado.</div></div>`
      : l.status === 'offline'
        ? `<div class="banner error">${icon('wifiOff')}<div><b>Estacionamiento sin conexión.</b> No mostramos datos que podrían ser incorrectos y las reservas están en pausa hasta que se recupere la conexión.</div></div>`
        : '';
  }
  if (l.status === 'offline' && d.spaces.length) { d.spaces = []; store.selected = null; renderPicker(); }
  if (wasOffline && l.status !== 'offline') renderLot(d.id); // se reconectó: recargar
  renderSummary();
}

function renderSummary() {
  const el = document.getElementById('summary');
  if (!el) return;
  const d = store.detail;
  const slots = arrivalSlots();
  if (!slots.includes(store.arrival)) store.arrival = slots[1];
  const canSubmit = d && d.reservable !== false && d.status !== 'offline' && store.selected && !store.submitting;
  el.innerHTML = `
    <h2>Resumen de reserva</h2>
    <div class="sel-box"><span>Espacio seleccionado</span>${store.selected ? `<b>${esc(store.selected)}</b>` : '<b class="none">Ninguno</b>'}</div>
    <div class="row"><div class="ic">${icon('cal')}</div><div><small>Fecha</small><strong>${fmtDateLong(store.arrival)}</strong></div></div>
    <div class="row"><div class="ic">${icon('clock')}</div><div><small>Hora de llegada</small>
      <select id="arrival">${slots.map((t) => `<option value="${t}" ${t === store.arrival ? 'selected' : ''}>${fmtTime(t)}</option>`).join('')}</select></div></div>
    <div class="row"><div class="ic">${icon('building')}</div><div><small>Ubicación</small><strong>${esc(d?.name || '')}</strong></div></div>
    ${store.uncertain ? `<div class="banner warn" style="margin:20px 0 0">${icon('alert')}<div>No pudimos confirmar con el estacionamiento. <b>Reintenta</b>: usamos la misma clave, por lo que no se creará una reserva duplicada.</div></div>` : ''}
    <button class="btn btn-primary btn-lg" id="confirm" ${canSubmit ? '' : 'disabled'}>
      ${store.submitting ? '<span class="spinner"></span> Confirmando con el estacionamiento…' : `${store.uncertain ? 'Reintentar reserva' : 'Confirmar reserva'} ${icon('chevR')}`}
    </button>
    <div class="fineprint">${icon('shield')} Puedes cancelar sin costo antes de tu llegada</div>`;
  el.querySelector('#arrival').addEventListener('change', (e) => { store.arrival = Number(e.target.value); store.uncertain = false; renderSummary(); });
  el.querySelector('#confirm').addEventListener('click', submitReservation);
}

async function submitReservation() {
  const d = store.detail;
  const spaceId = store.selected;
  if (!d || !spaceId || store.submitting) return;
  // Se reutiliza la clave de idempotencia si es un reintento de la MISMA solicitud.
  const same = store.pending && store.pending.spaceId === spaceId && store.pending.arrival === store.arrival;
  const key = same ? store.pending.key : uuid();
  store.pending = { spaceId, arrival: store.arrival, key };
  store.submitting = true;
  renderSummary();
  try {
    const r = await fetch(`/api/lots/${d.id}/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId, arrivalTime: store.arrival, userId, idempotencyKey: key }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 201 || r.status === 200) {
      saveReservation({ ...data, lotName: d.name, access: d.access, distanceM: d.distanceM, color: d.color });
      store.pending = null;
      store.uncertain = false;
      location.hash = `#/reserva/${encodeURIComponent(data.code)}`;
      return;
    }
    if (r.status === 409) {
      toast(`${icon('x')} ${esc(data.message || 'El espacio ya no está disponible.')} Otro usuario lo reservó primero.`, 'error');
      const s = d.spaces.find((x) => x.id === spaceId);
      if (s) applySpaces(d.spaces.map((x) => (x.id === spaceId ? { ...x, status: data.currentStatus || 'reservado' } : x)), d.version);
      store.selected = null;
      store.pending = null;
      store.uncertain = false;
    } else if (r.status === 504) {
      store.uncertain = true;
    } else {
      toast(esc(data.message || 'No se pudo completar la reserva.'), 'error');
      store.uncertain = false;
    }
  } catch {
    store.uncertain = true; // no sabemos si llegó: se permite reintentar con la misma clave
  } finally {
    store.submitting = false;
    if (store.view === 'lot') renderSummary();
  }
}

// ── Vista: Confirmación ───────────────────────────────────────────────────────
async function renderConfirm(code) {
  store.view = 'confirm';
  let r = myReservations().find((x) => x.code === code);
  const draw = () => {
    if (!r) {
      $app.innerHTML = `<div class="container page"><div class="card confirm"><div class="empty">Reserva no encontrada en este dispositivo.</div><a class="btn btn-primary" href="#/">Volver al inicio ${icon('chevR')}</a></div></div>`;
      return;
    }
    const active = r.status === 'activa';
    const title = active ? `Tu espacio ${esc(r.spaceId)} te espera` : `Reserva ${r.status}`;
    $app.innerHTML = `
    <div class="container page">
      <div class="lot-head">
        <div class="avatar ${r.color || 'blue'}">${esc(r.lotId)}</div>
        <div>
          <div class="eyebrow">Reserva de espacio</div>
          <h1>${esc(r.lotName)}</h1>
          <div class="addr">${icon('pin')} ${esc(r.access || '')}${r.distanceM ? ` · ${fmtDist(r.distanceM)}` : ''}</div>
        </div>
      </div>
      <div class="card confirm">
        <div class="ok ${active ? '' : 'cancel'}">${icon(active ? 'shield' : 'x')}</div>
        <div class="eyebrow">${active ? 'Reserva confirmada' : 'Reserva no vigente'}</div>
        <h1>${title}</h1>
        <p class="when">${fmtWeekday(r.arrivalTime)} · ${fmtTime(r.arrivalTime)}</p>
        <div class="code-box"><small>CÓDIGO DE RESERVA</small><div>${esc(r.code)}</div></div>
        <div class="actions">
          <a class="btn btn-primary" href="#/">Volver al inicio ${icon('chevR')}</a>
          ${active ? `<div class="cancel-slot"><button class="btn btn-danger-outline" data-cancel>${icon('x')} Cancelar reserva</button></div>` : ''}
        </div>
      </div>
    </div>`;
    if (active) {
      bindCancel($app.querySelector('.confirm'), r, (updated) => {
        if (updated) r = updated;
        else r = myReservations().find((x) => x.code === code) || r;
        draw();
      });
    }
  };
  draw();
  // Refresca el estado real desde el nodo dueño (puede haber expirado o sido cancelada).
  if (r) {
    try {
      const res = await fetch(`/api/lots/${r.lotId}/reservations/${encodeURIComponent(code)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status !== r.status && store.view === 'confirm') { r = { ...r, status: data.status }; saveReservation(r); draw(); }
      }
    } catch { /* se muestra la copia local */ }
  }
}

// ── Inicio ────────────────────────────────────────────────────────────────────
fetch('/api/lots').then((r) => r.json()).then((lots) => { store.lots = lots; route(); }).catch(() => route());
connect();

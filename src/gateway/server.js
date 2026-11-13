// ─────────────────────────────────────────────────────────────────────────────
// GATEWAY / AGREGADOR
//  - Recibe heartbeats (snapshots) de cada nodo y mantiene una caché integrada.
//  - Calcula el estado de conexión de cada nodo según la antigüedad del último dato:
//      online (< ONLINE_MS) · intermittent (< STALE_MS) · offline (sin datos recientes)
//  - LECTURAS: se sirven desde la caché (disponibilidad alta), indicando su frescura.
//  - ESCRITURAS (reservas): se reenvían SIEMPRE al nodo dueño, que decide (consistencia).
//    Con timeout, reintentos y clave de idempotencia; fail-fast si el nodo está caído.
//  - Envía actualizaciones en tiempo real al navegador mediante Server-Sent Events.
//  - Sirve el frontend estático (public/).
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadLots, paths, sendJson, readBody, fetchJson, makeLogger, sleep } from '../shared/util.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ONLINE_MS = Number(process.env.ONLINE_MS || 6000);
const STALE_MS = Number(process.env.STALE_MS || 15000);
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 2500);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const GATEWAY_ID = process.env.GATEWAY_ID || 'gw-1';

const log = makeLogger(`gateway ${GATEWAY_ID}`);
const lots = loadLots();

// URL de cada nodo. Por defecto localhost:<port>; en Docker se pasa NODE_URLS=UC=http://node-uc:4001,...
const nodeUrls = Object.fromEntries(lots.map((l) => [l.id, `http://localhost:${l.port}`]));
for (const pair of (process.env.NODE_URLS || '').split(',').filter(Boolean)) {
  const [id, url] = pair.split('=');
  nodeUrls[id.trim().toUpperCase()] = url.trim();
}

// Caché: lotId -> { snapshot, lastSeen, url }
const cache = Object.fromEntries(lots.map((l) => [l.id, { snapshot: null, lastSeen: 0, url: nodeUrls[l.id] }]));
const lastStatus = {};

// ── Registro de eventos y SSE ────────────────────────────────────────────────
const events = [];
const sseClients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(msg);
}
function logEvent(level, lotId, message) {
  const e = { id: crypto.randomUUID(), ts: Date.now(), level, lotId, message };
  events.push(e);
  if (events.length > 200) events.shift();
  log(`${lotId ? `[${lotId}] ` : ''}${message}`);
  broadcast('log', e);
}

// ── Estado de cada estacionamiento ───────────────────────────────────────────
function statusOf(lotId) {
  const c = cache[lotId];
  if (!c.snapshot) return 'offline';
  const age = Date.now() - c.lastSeen;
  if (age < ONLINE_MS) return 'online';
  if (age < STALE_MS) return 'intermittent';
  return 'offline';
}

function lotSummary(l) {
  const c = cache[l.id];
  const status = statusOf(l.id);
  return {
    id: l.id,
    name: l.name,
    access: l.access,
    distanceM: l.distanceM,
    color: l.color,
    status,
    free: status === 'offline' || !c.snapshot ? null : c.snapshot.free,
    lastKnownFree: c.snapshot ? c.snapshot.free : null,
    total: c.snapshot ? c.snapshot.total : l.aisles.length * l.spacesPerAisle,
    version: c.snapshot?.version ?? null,
    dataAgeMs: c.snapshot ? Date.now() - c.lastSeen : null,
    reservable: status !== 'offline',
  };
}

function allSummaries() {
  const list = lots.map(lotSummary);
  // Recomendado: en línea, con espacios libres; puntuación = libres / distancia.
  const candidates = list.filter((l) => l.status === 'online' && l.free > 0);
  candidates.sort((a, b) => b.free / b.distanceM - a.free / a.distanceM);
  if (candidates[0]) candidates[0].recommended = true;
  list.sort((a, b) => a.distanceM - b.distanceM);
  return list;
}

/** Acepta un snapshot solo si es más nuevo (evita que un mensaje atrasado pise uno reciente). */
function acceptSnapshot(lotId, snap, url) {
  const c = cache[lotId];
  if (!c) return false;
  const prev = c.snapshot;
  const sameEpoch = prev && prev.epoch === snap.epoch;
  if (sameEpoch && snap.version < prev.version) {
    logEvent('warn', lotId, `Snapshot fuera de orden descartado (v${snap.version} < v${prev.version})`);
    return false;
  }
  const wasStatus = statusOf(lotId);
  c.snapshot = snap;
  c.lastSeen = Date.now();
  if (url) c.url = url;
  if (wasStatus === 'offline' && prev) {
    logEvent('ok', lotId, `Reconexión: reconciliado v${prev.version} → v${snap.version} (${snap.version - prev.version} cambios ocurridos sin conexión)`);
  } else if (!prev) {
    logEvent('ok', lotId, `Nodo registrado (v${snap.version}, ${snap.free}/${snap.total} libres)`);
  }
  return true;
}

// Vigila las transiciones de estado (online → intermittent → offline) y las notifica.
setInterval(() => {
  let changed = false;
  for (const l of lots) {
    const s = statusOf(l.id);
    if (lastStatus[l.id] !== s) {
      if (lastStatus[l.id]) {
        const lvl = s === 'online' ? 'ok' : s === 'intermittent' ? 'warn' : 'error';
        logEvent(lvl, l.id, `Estado de conexión: ${lastStatus[l.id]} → ${s}`);
      }
      lastStatus[l.id] = s;
      changed = true;
    }
  }
  if (changed) broadcast('lots', allSummaries());
}, 1000);

// ── Reenvío con reintentos e idempotencia ────────────────────────────────────
async function forwardWithRetry(lotId, pathName, options, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fetchJson(`${cache[lotId].url}${pathName}`, { ...options, timeoutMs: FORWARD_TIMEOUT_MS });
      if (attempt > 1) logEvent('ok', lotId, `${label}: éxito en el intento ${attempt}`);
      return r;
    } catch (err) {
      lastErr = err;
      logEvent('warn', lotId, `${label}: intento ${attempt}/${MAX_RETRIES} falló (${err.message})`);
      if (attempt < MAX_RETRIES) await sleep(250 * 2 ** (attempt - 1)); // backoff exponencial
    }
  }
  throw lastErr;
}

/** Lectura con "read-through": intenta datos frescos del nodo; si falla, usa caché. */
async function getLotDetail(lotId) {
  const l = lots.find((x) => x.id === lotId);
  let source = 'cache';
  if (statusOf(lotId) !== 'offline') {
    try {
      const r = await fetchJson(`${cache[lotId].url}/snapshot`, { timeoutMs: 1500 });
      if (r.ok) {
        acceptSnapshot(lotId, r.data);
        source = 'node';
      }
    } catch { /* se usa la caché */ }
  }
  const c = cache[lotId];
  return {
    ...lotSummary(l),
    aisles: l.aisles,
    source,
    spaces: statusOf(lotId) === 'offline' ? [] : (c.snapshot?.spaces ?? []),
  };
}

// ── Archivos estáticos ───────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
  const file = path.normalize(path.join(paths.public, rel));
  if (!file.startsWith(paths.public)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ── API ──────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // Heartbeat de un nodo
    if (req.method === 'POST' && p === '/internal/sync') {
      const { snapshot, url: nodeUrl } = await readBody(req);
      if (!snapshot?.lotId || !cache[snapshot.lotId]) return sendJson(res, 400, { error: 'lotId desconocido' });
      if (acceptSnapshot(snapshot.lotId, snapshot, nodeUrl)) {
        broadcast('lot', { id: snapshot.lotId, version: snapshot.version, spaces: snapshot.spaces });
        broadcast('lots', allSummaries());
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: lots\ndata: ${JSON.stringify(allSummaries())}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    if (req.method === 'GET' && p === '/api/lots') return sendJson(res, 200, allSummaries());

    let m = p.match(/^\/api\/lots\/(\w+)$/);
    if (m && req.method === 'GET') {
      const id = m[1].toUpperCase();
      if (!cache[id]) return sendJson(res, 404, { error: 'NOT_FOUND' });
      return sendJson(res, 200, await getLotDetail(id));
    }

    // Crear reserva → se reenvía al nodo dueño del espacio
    m = p.match(/^\/api\/lots\/(\w+)\/reservations$/);
    if (m && req.method === 'POST') {
      const id = m[1].toUpperCase();
      if (!cache[id]) return sendJson(res, 404, { error: 'NOT_FOUND' });
      const body = await readBody(req);
      if (!body.spaceId) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'Falta spaceId' });
      body.idempotencyKey ||= crypto.randomUUID();
      // Fail-fast (circuit breaker simple): no se intenta contactar un nodo sin conexión.
      if (statusOf(id) === 'offline') {
        logEvent('error', id, `Reserva de ${body.spaceId} rechazada: estacionamiento sin conexión`);
        return sendJson(res, 503, { error: 'LOT_UNAVAILABLE', message: 'El estacionamiento no está conectado. La reserva no está disponible por ahora.' });
      }
      try {
        const r = await forwardWithRetry(id, '/reservations', { method: 'POST', body }, `Reserva ${body.spaceId}`);
        if (r.status === 201) logEvent('ok', id, `Reserva confirmada ${r.data.code} (espacio ${body.spaceId})`);
        else if (r.status === 200 && r.data?.replayed) logEvent('ok', id, `Reintento idempotente: se devolvió la reserva existente ${r.data.code} (sin duplicar)`);
        else if (r.status === 409) logEvent('warn', id, `Conflicto: ${r.data.message}`);
        return sendJson(res, r.status, r.data);
      } catch (err) {
        logEvent('error', id, `Reserva de ${body.spaceId} sin confirmar tras ${MAX_RETRIES} intentos`);
        return sendJson(res, 504, {
          error: 'UNCERTAIN',
          idempotencyKey: body.idempotencyKey,
          message: 'No pudimos confirmar con el estacionamiento. Reintenta: tu solicitud no se duplicará.',
        });
      }
    }

    m = p.match(/^\/api\/lots\/(\w+)\/reservations\/([\w-]+)$/);
    if (m && (req.method === 'DELETE' || req.method === 'GET')) {
      const id = m[1].toUpperCase();
      if (!cache[id]) return sendJson(res, 404, { error: 'NOT_FOUND' });
      if (statusOf(id) === 'offline') return sendJson(res, 503, { error: 'LOT_UNAVAILABLE', message: 'El estacionamiento no está conectado. Intenta más tarde.' });
      try {
        const r = await forwardWithRetry(id, `/reservations/${m[2]}`, { method: req.method }, `${req.method === 'DELETE' ? 'Cancelación' : 'Consulta'} ${m[2]}`);
        if (req.method === 'DELETE' && r.ok) logEvent('ok', id, `Reserva ${m[2]} cancelada`);
        return sendJson(res, r.status, r.data);
      } catch {
        return sendJson(res, 504, { error: 'UNCERTAIN', message: 'No pudimos contactar al estacionamiento. Intenta de nuevo.' });
      }
    }

    // ── Panel de simulación ──
    if (req.method === 'GET' && p === '/api/admin/nodes') {
      const nodes = await Promise.all(lots.map(async (l) => {
        let mode = null;
        try {
          const r = await fetchJson(`${nodeUrls[l.id]}/admin/state`, { timeoutMs: 800 });
          mode = r.data?.mode ?? null;
        } catch { /* proceso caído */ }
        return { ...lotSummary(l), mode, processUp: mode !== null, url: cache[l.id].url };
      }));
      return sendJson(res, 200, { gatewayId: GATEWAY_ID, nodes, events: events.slice(-80) });
    }

    m = p.match(/^\/api\/admin\/nodes\/(\w+)\/network$/);
    if (m && req.method === 'POST') {
      const id = m[1].toUpperCase();
      const { mode } = await readBody(req);
      try {
        const r = await fetchJson(`${nodeUrls[id]}/admin/network`, { method: 'POST', body: { mode }, timeoutMs: 1500 });
        logEvent('info', id, `Simulación: red del nodo cambiada a "${mode}"`);
        return sendJson(res, r.status, r.data);
      } catch {
        return sendJson(res, 502, { error: 'El proceso del nodo no responde (¿está detenido?)' });
      }
    }

    // Demostración de concurrencia: dos usuarios reservan el mismo espacio a la vez.
    m = p.match(/^\/api\/admin\/nodes\/(\w+)\/conflict-demo$/);
    if (m && req.method === 'POST') {
      const id = m[1].toUpperCase();
      const detail = await getLotDetail(id);
      const free = detail.spaces.filter((s) => s.status === 'libre');
      if (!free.length) return sendJson(res, 409, { error: 'No hay espacios libres para la demostración' });
      const space = free[Math.floor(Math.random() * free.length)];
      logEvent('info', id, `Demo de concurrencia: usuarios "Ana" y "Luis" reservan ${space.id} simultáneamente`);
      const attempt = (user) => fetchJson(`http://localhost:${PORT}/api/lots/${id}/reservations`, {
        method: 'POST', timeoutMs: 15000,
        body: { spaceId: space.id, userId: user, arrivalTime: Date.now() + 30 * 60_000, idempotencyKey: crypto.randomUUID() },
      }).then((r) => ({ user, status: r.status, data: r.data })).catch((e) => ({ user, status: 0, data: { message: e.message } }));
      const results = await Promise.all([attempt('Ana'), attempt('Luis')]);
      return sendJson(res, 200, { spaceId: space.id, results });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    log('Error:', err.message);
    return sendJson(res, 500, { error: 'INTERNAL', message: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`Gateway escuchando en http://localhost:${PORT} · nodos: ${Object.entries(nodeUrls).map(([k, v]) => `${k}=${v}`).join(', ')}`);
});

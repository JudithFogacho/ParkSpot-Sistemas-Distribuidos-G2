// ─────────────────────────────────────────────────────────────────────────────
// NODO DE ESTACIONAMIENTO
// Cada estacionamiento ejecuta su propia instancia de este proceso.
//  - Es la ÚNICA fuente de verdad (autoridad) de sus espacios y reservas.
//  - Persiste su estado localmente (data/<LOT_ID>.json), así sobrevive a reinicios.
//  - Simula sensores (no hay hardware real) que ocupan/liberan espacios.
//  - Envía heartbeats con su snapshot al gateway (modelo push).
//  - Puede simular fallos de red: online | intermittent | offline.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  loadLots, paths, sendJson, readBody, fetchJson, makeLogger, writeJsonAtomic, sleep, rand,
} from '../shared/util.js';

const LOT_ID = (process.env.LOT_ID || 'UC').toUpperCase();
const lot = loadLots().find((l) => l.id === LOT_ID);
if (!lot) {
  console.error(`LOT_ID desconocido: ${LOT_ID}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT || lot.port);
const HOST = process.env.HOST || '0.0.0.0';
// Se admiten varios gateways separados por coma (replicación del agregador).
const GATEWAY_URLS = (process.env.GATEWAY_URLS || process.env.GATEWAY_URL || 'http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 2000);
const SENSOR_MIN_MS = Number(process.env.SENSOR_MIN_MS || 2500);
const SENSOR_MAX_MS = Number(process.env.SENSOR_MAX_MS || 6000);
const GRACE_MIN = Number(process.env.GRACE_MIN || 15); // tolerancia tras la hora de llegada
const DATA_FILE = path.join(paths.data, `${LOT_ID}.json`);

const log = makeLogger(`nodo ${LOT_ID}`);

// Modo de red simulado. El panel de administración lo cambia en caliente.
let networkMode = ['online', 'intermittent', 'offline'].includes(process.env.INITIAL_MODE)
  ? process.env.INITIAL_MODE : 'online';

// ── Estado ───────────────────────────────────────────────────────────────────
function initialState() {
  const spaces = [];
  for (const aisle of lot.aisles) {
    for (let i = 1; i <= lot.spacesPerAisle; i++) {
      spaces.push({
        id: `${aisle}${String(i).padStart(2, '0')}`,
        aisle,
        status: Math.random() < lot.targetOccupancy ? 'ocupado' : 'libre',
        reservationCode: null,
        updatedAt: Date.now(),
      });
    }
  }
  return {
    lotId: LOT_ID,
    // epoch identifica una "vida" del estado. Si se borra el archivo, cambia,
    // y el gateway sabe que debe aceptar una versión menor.
    epoch: crypto.randomUUID(),
    version: 1,
    spaces,
    reservations: {},
    idempotency: {}, // idempotencyKey -> reservationCode
  };
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    log(`Estado recuperado de disco (versión ${s.version}).`);
    return s;
  } catch {
    const s = initialState();
    writeJsonAtomic(DATA_FILE, s);
    log('Estado inicial creado.');
    return s;
  }
}

const state = loadState();
const spaceById = (id) => state.spaces.find((s) => s.id === id);

let saveTimer = null;
/** Toda mutación pasa por aquí: incrementa la versión (reloj lógico) y persiste. */
function commit(reason) {
  state.version += 1;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJsonAtomic(DATA_FILE, state), 100);
  if (reason) log(`v${state.version} · ${reason}`);
  // Propagación inmediata de cambios importantes (no esperar al siguiente heartbeat).
  pushSnapshot();
}

function snapshot() {
  const free = state.spaces.filter((s) => s.status === 'libre').length;
  return {
    lotId: LOT_ID,
    epoch: state.epoch,
    version: state.version,
    generatedAt: Date.now(),
    total: state.spaces.length,
    free,
    spaces: state.spaces.map(({ id, aisle, status }) => ({ id, aisle, status })),
  };
}

// ── Simulación de sensores ───────────────────────────────────────────────────
// Los sensores siguen funcionando aunque el nodo pierda conectividad con el gateway:
// el estado local sigue cambiando y se reconcilia al volver la conexión.
function sensorTick() {
  const candidates = state.spaces.filter((s) => s.status !== 'reservado');
  if (candidates.length) {
    const s = candidates[Math.floor(Math.random() * candidates.length)];
    const next = Math.random() < lot.targetOccupancy ? 'ocupado' : 'libre';
    if (next !== s.status) {
      s.status = next;
      s.updatedAt = Date.now();
      commit(`sensor ${s.id} → ${next}`);
    }
  }
  setTimeout(sensorTick, rand(SENSOR_MIN_MS, SENSOR_MAX_MS));
}

// Expiración de reservas: si pasa la hora de llegada + tolerancia, se libera.
function expireReservations() {
  const now = Date.now();
  for (const r of Object.values(state.reservations)) {
    if (r.status === 'activa' && now > r.arrivalTime + GRACE_MIN * 60_000) {
      r.status = 'expirada';
      const s = spaceById(r.spaceId);
      if (s && s.reservationCode === r.code) {
        s.status = 'libre';
        s.reservationCode = null;
      }
      commit(`reserva ${r.code} expirada`);
    }
  }
}

// ── Heartbeats al gateway ────────────────────────────────────────────────────
let pushing = false;
let pushAgain = false;
async function pushSnapshot() {
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    do {
      pushAgain = false;
      if (networkMode === 'offline') return;
      if (networkMode === 'intermittent') {
        if (Math.random() < 0.6) return; // paquete perdido
        await sleep(rand(300, 2500));    // latencia alta
      }
      const body = { url: SELF_URL, snapshot: snapshot() };
      await Promise.all(GATEWAY_URLS.map((g) =>
        fetchJson(`${g}/internal/sync`, { method: 'POST', body, timeoutMs: 2000 }).catch(() => null)));
    } while (pushAgain);
  } finally {
    pushing = false;
  }
}

// ── Lógica de reservas ───────────────────────────────────────────────────────
function makeCode(spaceId, arrival) {
  const d = new Date(arrival);
  const ddmm = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 3);
  return `PS-${ddmm}-${spaceId}-${suffix}`;
}

/**
 * Crear reserva. Node.js ejecuta este bloque sin interrupciones (un solo hilo,
 * sin await entre la validación y la escritura), por lo que la comprobación
 * "¿está libre?" y la asignación son ATÓMICAS: dos peticiones simultáneas por el
 * mismo espacio nunca pueden ganar ambas.
 */
function createReservation({ spaceId, arrivalTime, userId, idempotencyKey }) {
  // Idempotencia: un reintento de la misma operación devuelve el mismo resultado.
  if (idempotencyKey && state.idempotency[idempotencyKey]) {
    const r = state.reservations[state.idempotency[idempotencyKey]];
    return { status: 200, body: { ...r, replayed: true } };
  }
  const s = spaceById(spaceId);
  if (!s) return { status: 404, body: { error: 'SPACE_NOT_FOUND', message: `El espacio ${spaceId} no existe.` } };

  const arrival = Number(arrivalTime) || Date.now();
  const now = Date.now();
  if (arrival < now - 10 * 60_000 || arrival > now + 24 * 3600_000) {
    return { status: 400, body: { error: 'INVALID_TIME', message: 'La hora de llegada debe estar dentro de las próximas 24 horas.' } };
  }
  if (s.status !== 'libre') {
    return {
      status: 409,
      body: { error: 'SPACE_TAKEN', message: `El espacio ${spaceId} ya no está disponible (${s.status}).`, currentStatus: s.status, version: state.version },
    };
  }
  const code = makeCode(spaceId, arrival);
  const reservation = {
    code, lotId: LOT_ID, spaceId, userId: userId || 'anon', arrivalTime: arrival,
    createdAt: now, status: 'activa',
  };
  state.reservations[code] = reservation;
  if (idempotencyKey) state.idempotency[idempotencyKey] = code;
  s.status = 'reservado';
  s.reservationCode = code;
  s.updatedAt = now;
  commit(`reserva ${code} creada (${spaceId})`);
  return { status: 201, body: reservation };
}

function cancelReservation(code) {
  const r = state.reservations[code];
  if (!r) return { status: 404, body: { error: 'NOT_FOUND', message: 'Reserva no encontrada.' } };
  if (r.status !== 'activa') return { status: 409, body: { error: 'NOT_ACTIVE', message: `La reserva está ${r.status}.` } };
  r.status = 'cancelada';
  const s = spaceById(r.spaceId);
  if (s && s.reservationCode === code) {
    s.status = 'libre';
    s.reservationCode = null;
    s.updatedAt = Date.now();
  }
  commit(`reserva ${code} cancelada`);
  return { status: 200, body: r };
}

// ── Servidor HTTP ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // Canal de administración "fuera de banda": no se ve afectado por el fallo
    // simulado (equivale a la consola del operador en sitio).
    if (p.startsWith('/admin/')) {
      if (req.method === 'GET' && p === '/admin/state') {
        return sendJson(res, 200, { lotId: LOT_ID, mode: networkMode, version: state.version, free: snapshot().free, total: state.spaces.length });
      }
      if (req.method === 'POST' && p === '/admin/network') {
        const { mode } = await readBody(req);
        if (!['online', 'intermittent', 'offline'].includes(mode)) return sendJson(res, 400, { error: 'Modo inválido' });
        const prev = networkMode;
        networkMode = mode;
        log(`Modo de red: ${prev} → ${mode}`);
        if (mode !== 'offline') pushSnapshot(); // reconciliación inmediata al reconectar
        return sendJson(res, 200, { lotId: LOT_ID, mode });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    // ── Simulación de fallos de red para el tráfico normal ──
    if (networkMode === 'offline') {
      // No respondemos: el cliente experimentará un timeout, como en una caída real.
      setTimeout(() => req.socket.destroy(), 30_000);
      return;
    }
    if (networkMode === 'intermittent') {
      if (Math.random() < 0.3) return req.socket.destroy(); // conexión cortada
      await sleep(rand(200, 1500));
    }

    if (req.method === 'GET' && p === '/health') {
      return sendJson(res, 200, { lotId: LOT_ID, version: state.version, mode: networkMode });
    }
    if (req.method === 'GET' && p === '/snapshot') {
      return sendJson(res, 200, snapshot());
    }
    if (req.method === 'POST' && p === '/reservations') {
      const body = await readBody(req);
      const result = createReservation(body);
      // En modo intermitente, a veces la respuesta se pierde DESPUÉS de procesar:
      // el gateway reintentará y la idempotencia evitará una reserva duplicada.
      if (networkMode === 'intermittent' && result.status === 201 && Math.random() < 0.3) {
        log(`(simulación) respuesta de ${result.body.code} perdida en la red`);
        return req.socket.destroy();
      }
      return sendJson(res, result.status, result.body);
    }
    let m = p.match(/^\/reservations\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const r = state.reservations[m[1]];
      return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: 'NOT_FOUND' });
    }
    if (m && req.method === 'DELETE') {
      const result = cancelReservation(m[1]);
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    log('Error:', err.message);
    return sendJson(res, 500, { error: 'INTERNAL', message: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`${lot.name} escuchando en ${SELF_URL} · gateway(s): ${GATEWAY_URLS.join(', ')} · modo ${networkMode}`);
  setInterval(pushSnapshot, HEARTBEAT_MS);
  setInterval(expireReservations, 10_000);
  setTimeout(sensorTick, rand(SENSOR_MIN_MS, SENSOR_MAX_MS));
  pushSnapshot();
});

function shutdown() {
  writeJsonAtomic(DATA_FILE, state);
  log('Estado guardado. Apagando.');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

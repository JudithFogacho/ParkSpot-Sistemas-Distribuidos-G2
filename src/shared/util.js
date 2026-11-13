// Utilidades compartidas por el gateway y los nodos de estacionamiento.
// Sin dependencias externas: solo módulos nativos de Node.js (>= 20).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const paths = {
  root: ROOT,
  config: path.join(ROOT, 'config', 'lots.json'),
  public: path.join(ROOT, 'public'),
  data: process.env.DATA_DIR || path.join(ROOT, 'data'),
};

export function loadLots() {
  return JSON.parse(fs.readFileSync(paths.config, 'utf8'));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => min + Math.random() * (max - min);

export function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body demasiado grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * fetch con timeout. Lanza un error con code = 'TIMEOUT' o 'NETWORK'
 * cuando el otro extremo no responde (fallo parcial de red).
 */
export async function fetchJson(url, { method = 'GET', body, timeoutMs = 2500, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    const e = new Error(ctrl.signal.aborted ? `Timeout tras ${timeoutMs} ms` : `Error de red: ${err.cause?.code || err.message}`);
    e.code = ctrl.signal.aborted ? 'TIMEOUT' : 'NETWORK';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function makeLogger(name) {
  const tag = `[${name}]`;
  return (...args) => console.log(new Date().toISOString().slice(11, 19), tag, ...args);
}

/** Escritura atómica: se escribe en un temporal y se renombra (evita JSON corrupto si el proceso cae). */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

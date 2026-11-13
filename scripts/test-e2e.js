// Prueba de extremo a extremo: levanta gateway + 3 nodos en puertos alternos
// y verifica consistencia, idempotencia, concurrencia y tolerancia a fallos.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadLots, fetchJson, sleep } from '../src/shared/util.js';

const GW = 3900;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parkspot-test-'));
const lots = loadLots();
const procs = [];
const nodePort = (i) => 4900 + i;

const start = (script, env) => procs.push(spawn(process.execPath, [script], { env: { ...process.env, DATA_DIR: dataDir, ...env }, stdio: 'ignore' }));
start('src/gateway/server.js', {
  PORT: String(GW), ONLINE_MS: '3000', STALE_MS: '6000',
  NODE_URLS: lots.map((l, i) => `${l.id}=http://localhost:${nodePort(i)}`).join(','),
});
lots.forEach((l, i) => start('src/node/server.js', {
  LOT_ID: l.id, PORT: String(nodePort(i)), GATEWAY_URL: `http://localhost:${GW}`, HEARTBEAT_MS: '1000',
}));

const api = (p, o) => fetchJson(`http://localhost:${GW}${p}`, { timeoutMs: 15000, ...o });
const reserve = (lot, spaceId, key = crypto.randomUUID()) =>
  api(`/api/lots/${lot}/reservations`, { method: 'POST', body: { spaceId, arrivalTime: Date.now() + 1800_000, userId: 'test', idempotencyKey: key } });
const freeSpace = async (lot) => (await api(`/api/lots/${lot}`)).data.spaces.find((s) => s.status === 'libre').id;

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`  ✔ ${name}`);
}

try {
  await sleep(2500);
  await step('los 3 nodos se registran y aparecen en línea', async () => {
    const { data } = await api('/api/lots');
    assert.equal(data.length, 3);
    data.forEach((l) => assert.equal(l.status, 'online', `${l.id} debería estar en línea`));
  });

  let code;
  const key = crypto.randomUUID();
  const sp = await freeSpace('UC');
  await step('reservar un espacio libre devuelve 201', async () => {
    const r = await reserve('UC', sp, key);
    assert.equal(r.status, 201);
    code = r.data.code;
  });
  await step('reintento con la misma clave de idempotencia no duplica (200, misma reserva)', async () => {
    const r = await reserve('UC', sp, key);
    assert.equal(r.status, 200);
    assert.equal(r.data.code, code);
    assert.equal(r.data.replayed, true);
  });
  await step('otro usuario no puede reservar el mismo espacio (409)', async () => {
    const r = await reserve('UC', sp);
    assert.equal(r.status, 409);
  });
  await step('20 solicitudes concurrentes por un mismo espacio → exactamente 1 gana', async () => {
    const s = await freeSpace('CC');
    const rs = await Promise.all(Array.from({ length: 20 }, () => reserve('CC', s)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 19);
  });
  await step('cancelar libera el espacio', async () => {
    const r = await api(`/api/lots/UC/reservations/${code}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'cancelada');
    const again = await reserve('UC', sp);
    assert.equal(again.status, 201);
  });
  await step('nodo sin conexión → el gateway lo marca offline y rechaza reservas (503, fail-fast)', async () => {
    await api('/api/admin/nodes/HM/network', { method: 'POST', body: { mode: 'offline' } });
    await sleep(7500);
    const { data } = await api('/api/lots');
    const hm = data.find((l) => l.id === 'HM');
    assert.equal(hm.status, 'offline');
    assert.equal(hm.free, null);
    const r = await reserve('HM', 'A01');
    assert.equal(r.status, 503);
    // Los demás nodos siguen funcionando (fallo parcial)
    assert.equal(data.find((l) => l.id === 'UC').status, 'online');
  });
  await step('al reconectarse, el nodo se reconcilia y vuelve a estar en línea', async () => {
    const before = (await api('/api/admin/nodes')).data.nodes.find((n) => n.id === 'HM').version;
    await api('/api/admin/nodes/HM/network', { method: 'POST', body: { mode: 'online' } });
    await sleep(2000);
    const hm = (await api('/api/lots')).data.find((l) => l.id === 'HM');
    assert.equal(hm.status, 'online');
    assert.ok(hm.version >= before);
  });
  await step('en modo intermitente, reintentos + idempotencia → nunca reservas duplicadas', async () => {
    await api('/api/admin/nodes/UC/network', { method: 'POST', body: { mode: 'intermittent' } });
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      const s = await freeSpace('UC').catch(() => null);
      if (!s) continue;
      const k = crypto.randomUUID();
      let r = await reserve('UC', s, k);
      while (r.status === 504) r = await reserve('UC', s, k); // el cliente reintenta con la misma clave
      outcomes.push(r.status);
    }
    await api('/api/admin/nodes/UC/network', { method: 'POST', body: { mode: 'online' } });
    await sleep(1500);
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'UC.json'), 'utf8'));
    const active = Object.values(st.reservations).filter((r) => r.status === 'activa');
    const perSpace = new Set(active.map((r) => r.spaceId));
    assert.equal(perSpace.size, active.length, 'no puede haber 2 reservas activas en un mismo espacio');
    assert.ok(outcomes.every((s) => [200, 201, 409, 503].includes(s)), `resultados: ${outcomes}`);
  });
  console.log(`\n${passed} pruebas superadas.`);
} catch (err) {
  console.error('\n✖ Falló:', err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill('SIGTERM'));
  await sleep(300);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

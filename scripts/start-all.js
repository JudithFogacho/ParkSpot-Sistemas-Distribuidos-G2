// Lanza el sistema completo en una sola máquina: 1 gateway + 1 proceso por estacionamiento.
// Cada proceso es independiente (puerto, memoria y archivo de datos propios),
// por lo que se puede detener uno solo para simular una caída real.
import { spawn } from 'node:child_process';
import { loadLots } from '../src/shared/util.js';

const colors = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m'];
const reset = '\x1b[0m';
const children = [];

function run(name, script, env, color) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${color}${name.padEnd(8)}${reset}│ `;
  const pipe = (stream, out) => stream.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => out.write(prefix + l + '\n')));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefix}proceso terminado (código ${code})`));
  children.push(child);
}

run('gateway', 'src/gateway/server.js', { PORT: '3000' }, colors[3]);
loadLots().forEach((l, i) => run(`nodo-${l.id}`, 'src/node/server.js', { LOT_ID: l.id, PORT: String(l.port) }, colors[i % 3]));

console.log('\n  ➜ Aplicación:          http://localhost:3000');
console.log('  ➜ Panel de simulación: http://localhost:3000/admin\n');

const stop = () => { children.forEach((c) => c.kill('SIGTERM')); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

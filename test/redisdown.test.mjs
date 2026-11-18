// Con el almacenamiento (Redis) caído: las cuentas fallan CERRADO (503) y el contenido falla ABIERTO (S2).
import test from 'node:test';
import assert from 'node:assert/strict';
import './mock-fetch.mjs'; // cualquier host desconocido (incluido Redis) responde error: simula la caída
process.env.PORT = '3994';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis-caido.example';
process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
await import('../server/server.js');
const base = 'http://localhost:3994';
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('sin almacenamiento: acceso, registro y recuperación responden 503 (no se prueban contraseñas sin freno)', async () => {
  for (const [p, b] of [['/api/auth/login', { email: 'a@x.com', password: 'clave-segura' }], ['/api/auth/register', { email: 'b@x.com', password: 'clave-segura', name: 'B' }], ['/api/auth/forgot', { email: 'a@x.com' }]]) {
    const r = await post(p, b); assert.equal(r.status, 503, p); assert.match((await r.json()).error, /no está disponible/);
  }
});
test('sin almacenamiento: el contenido público sigue funcionando (falla abierto)', async () => {
  assert.equal((await fetch(base + '/api/music/search?q=muse')).status, 200);
  assert.equal((await fetch(base + '/api/music/charts')).status, 200);
});
test.after(() => setTimeout(() => process.exit(0), 50));

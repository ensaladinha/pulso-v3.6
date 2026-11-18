// Servidor real con fuentes simuladas: login, datos viejos ante una caída, límites compartidos, perfil atómico y contenido +18.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calls, external_ } from './mock-fetch.mjs';

process.env.PORT = '3995';
process.env.TRUST_PROXY = '1'; // así la IP sale de X-Forwarded-For y se pueden simular varias personas
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulso-res-')), 'db.json');
const { strip } = await import('../server/server.js');
const base = 'http://localhost:3995';
const req = (p, o = {}, ip = '10.0.0.1') => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(o.headers || {}) } });
const send = (m, p, body, ip, headers) => req(p, { method: m, body: body === undefined ? undefined : JSON.stringify(body), headers }, ip);
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
const register = async (email, ip = '10.9.9.9') => cookieOf(await send('POST', '/api/auth/register', { email, password: 'clave-segura', name: 'T' }, ip));

test('login: un atacante bloquea SU IP contra la cuenta, no a la dueña desde otra IP (S1)', async () => {
  await register('victima@x.com');
  const codes = []; for (let i = 0; i < 12; i++) codes.push((await send('POST', '/api/auth/login', { email: 'victima@x.com', password: 'mala-' + i + 'xxxx' }, '66.6.6.6')).status);
  assert.equal(codes[0], 401); assert.equal(codes.at(-1), 429, 'el atacante queda bloqueado');
  assert.equal((await send('POST', '/api/auth/login', { email: 'victima@x.com', password: 'clave-segura' }, '66.6.6.6')).status, 429, 'ni con la clave correcta desde su IP');
  assert.equal((await send('POST', '/api/auth/login', { email: 'victima@x.com', password: 'clave-segura' }, '20.20.20.20')).status, 200, 'la dueña entra desde otra IP');
});
test('login: tope por IP antes de calcular scrypt (S3)', async () => {
  const codes = []; for (let i = 0; i < 34; i++) codes.push((await send('POST', '/api/auth/login', { email: `x${i}@x.com`, password: 'cualquiera1' }, '77.7.7.7')).status);
  assert.ok(codes.includes(429)); assert.equal(codes[0], 401);
});

test('perfil: DELETE deja un perfil vacío con versión nueva y un dispositivo viejo choca en vez de resucitarlo (B2)', async () => {
  const cookie = await register('del@x.com'), put = (profile, b) => send('PUT', '/api/profile', { profile, base: b }, '10.1.1.1', { cookie });
  assert.equal((await put({ bands: ['A'], favorites: [{ id: 'f' }] }, 0)).status, 200);
  const d = await (await send('DELETE', '/api/profile', undefined, '10.1.1.1', { cookie })).json();
  assert.equal(d.ok, true); assert.deepEqual(d.profile.bands, []); assert.equal(d.profile.rev, 2);
  const old = await put({ bands: ['RESUCITA'] }, 1); assert.equal(old.status, 409);
  assert.deepEqual((await old.json()).profile.bands, []);
  assert.equal((await send('DELETE', '/api/profile', undefined, '10.1.1.1')).status, 401, 'sin sesión');
});
test('perfil: guardados simultáneos con la misma versión — solo uno pasa (S9)', async () => {
  const cookie = await register('atomico@x.com');
  await send('PUT', '/api/profile', { profile: { bands: ['0'] }, base: 0 }, '10.2.2.2', { cookie }); // rev 1
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => send('PUT', '/api/profile', { profile: { bands: ['c' + i] }, base: 1 }, '10.2.2.2', { cookie })));
  const codes = rs.map(r => r.status).sort();
  assert.equal(codes.filter(c => c === 200).length, 1); assert.equal(codes.filter(c => c === 409).length, 11);
});
test('datos personales: nunca se cachean (no-store)', async () => {
  const cookie = await register('nostore@x.com');
  for (const p of ['/api/auth/me', '/api/profile']) assert.equal((await req(p, { headers: { cookie } })).headers.get('cache-control'), 'no-store', p);
});

test('búsquedas: mayúsculas y espacios son el mismo pedido y hay un tope compartido (R5)', async () => {
  const itunes = () => calls.filter(u => u.includes('itunes.apple.com/search') && !u.includes('attribute')).length, n0 = itunes();
  for (const q of ['Muse', 'muse', '  MUSE  ', 'mu%20se'.replace('%20', '+').replace('mu+se', 'muse')]) assert.equal((await req('/api/music/search?q=' + encodeURIComponent(q), {}, '10.3.3.3')).status, 200);
  assert.equal(itunes() - n0, 1, 'una sola llamada a iTunes');
  const codes = []; for (let i = 0; i < 45; i++) codes.push((await req('/api/music/search?q=distinto' + i, {}, '10.3.3.4')).status);
  assert.ok(codes.includes(429), 'aparece un 429'); assert.ok(codes.slice(0, 5).every(c => c === 200));
});
test('artistas con coma o &: el nombre viaja entero con «|» (B6)', async () => {
  const r = await (await req('/api/music/artists?names=' + encodeURIComponent('Coldplay|Muse'), {}, '10.4.4.4')).json();
  assert.deepEqual([...new Set(r.map(s => s.artist))].sort(), ['Coldplay', 'Muse']);
});

test('contenido +18 de punta a punta: Steam (descriptor 4), BBCode limpio y canciones/películas marcadas (B7, B9)', async () => {
  const news = await (await req('/api/games/news', {}, '10.5.5.5')).json();
  const adult = news.find(n => /222/.test(n.title)), normal = news.find(n => /111/.test(n.title));
  assert.equal(adult.adult, true, 'descriptor 4 → adulto'); assert.ok(!normal.adult, 'descriptor 2 (violencia) no se oculta');
  assert.ok(!/\[|\]|STEAM_CLAN_IMAGE|<|>/.test(normal.summary), 'sin BBCode: ' + normal.summary);
  assert.ok(normal.summary.includes('nuevo') && normal.summary.includes('Más info'));
  const songs = await (await req('/api/music/search?q=algo', {}, '10.5.5.5')).json();
  assert.equal(songs.find(s => s.title === 'Tema con groserías').explicit, true); assert.ok(!songs.find(s => s.title === 'Tema limpio').explicit);
  const media = await (await req('/api/media/search?q=monja', {}, '10.5.5.5')).json();
  assert.equal(media.find(m => m.title === 'Película solo adultos').adult, true); assert.ok(!media.find(m => m.title === 'La Monja').adult, 'R no se oculta');
});
test('strip: BBCode, imágenes y etiquetas cortadas al final', () => {
  assert.equal(strip('[h1]Hola[/h1] [img]{STEAM_CLAN_IMAGE}/1/a.png[/img] mundo [b]fuerte[/b] [url=https://x.y]link[/url] [list][*]uno[/list] fin [ur'), 'Hola mundo fuerte link uno fin');
  assert.equal(strip('<p>HTML <b>normal</b></p>'), 'HTML normal');
});

test('stale-on-error: si la fuente cae se sirve el último dato bueno, avisando, y recién al pasar el plazo da 502 (R2)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const h = 3600e3;
  const ok = await req('/api/music/charts', {}, '10.6.6.6'); assert.equal(ok.status, 200); assert.equal(ok.headers.get('x-pulso-fallback'), null);
  const fresh = await ok.json();
  const home0 = await (await req('/api/home', {}, '10.6.6.6')).json(); assert.deepEqual(home0.stale, []);
  t.mock.timers.tick(7 * h); // el dato venció (TTL 6 h) pero sigue siendo usable
  external_.down = true;
  try {
    const r = await req('/api/music/charts', {}, '10.6.6.6');
    assert.equal(r.status, 200, 'no se le devuelve un error a la gente'); assert.equal(r.headers.get('x-pulso-fallback'), 'stale');
    assert.match(r.headers.get('cache-control'), /max-age=30/); assert.deepEqual(await r.json(), fresh);
    const home = await (await req('/api/home', {}, '10.6.6.6')).json();
    // La música (TTL 6 h) sigue dentro de su plazo de tolerancia; las noticias (TTL 20 min) ya lo pasaron y figuran como caídas. Otras listas de 6 h también salen como «guardadas».
    assert.ok(home.stale.includes('Música (iTunes)'), 'la portada dice qué secciones muestran datos guardados');
    assert.ok(home.charts.length > 0 && !home.failed.includes('Música (iTunes)'));
    t.mock.timers.tick(30 * h); // pasó el plazo de tolerancia (12 h en total desde que se guardó)
    assert.equal((await req('/api/music/charts', {}, '10.6.6.6')).status, 502);
  } finally { external_.down = false; }
});
test.after(() => setTimeout(() => process.exit(0), 50));

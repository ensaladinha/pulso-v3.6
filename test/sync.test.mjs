// El cliente real (public/js/state.js) contra el servidor real: invitado persistente, borrado real, fusión en conflicto y errores de guardado.
// No hay navegador: se simulan localStorage y los eventos de la ventana, y fetch con ruta relativa apunta al servidor de prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './mock-fetch.mjs';

process.env.PORT = '3996';
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulso-sync-')), 'db.json');
const BASE = 'http://localhost:3996';

// --- entorno de navegador mínimo ---
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const events = [];
globalThis.dispatchEvent = e => { events.push(e); return true; };
const names = () => events.map(e => e.type);
let cookie = '', offline = false, forced = null;
const prev = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  const url = String(u);
  if (!url.startsWith('/api/')) return prev(u, o);
  if (offline) throw new TypeError('sin red');
  if (forced) return forced;
  return prev(BASE + url, { ...o, headers: { ...(o.headers || {}), cookie } });
};

await import('../server/server.js');
const st = await import('../public/js/state.js');
const { P, session, setProfile, setBands, learn, save, sync } = st;
const raw = (m, p, body, c = cookie) => prev(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', cookie: c }, body: body && JSON.stringify(body) });
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('tiempo agotado esperando'); await new Promise(r => setTimeout(r, 20)); } };
const flush = async () => { save(); st.retrySave(); await until(() => !sync.dirty); };
const serverProfile = async () => (await (await raw('GET', '/api/profile')).json()).profile;
const reg = async email => { const r = await raw('POST', '/api/auth/register', { email, password: 'clave-segura', name: 'T' }, ''); cookie = r.headers.get('set-cookie').split(';')[0]; return (await r.json()).user; };

test('invitado: los gustos se guardan en el navegador y sobreviven a una recarga (B5)', () => {
  session.user = null; setProfile(null); mem.clear();
  setBands(['Muse']); learn({ tags: ['genre:rock'] }, 4); P.onboardingDone = true; save();
  assert.ok(mem.get('pulso:guest:v1'), 'hay copia en localStorage');
  setProfile(null); assert.deepEqual(P.bands, []); // «recarga»: memoria vacía
  assert.equal(st.loadGuest(), true);
  assert.deepEqual(P.bands, ['Muse']); assert.equal(P.onboardingDone, true); assert.ok(P.tags['genre:rock']);
});
test('invitado: si localStorage falla o está corrupto no se rompe nada', () => {
  const ok = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('lleno'); }, removeItem() { throw new Error('x'); } };
  assert.doesNotThrow(() => { setBands(['A']); save(); st.loadGuest(); st.clearGuest(); });
  globalThis.localStorage = { ...ok, getItem: () => '{no es json' }; assert.equal(st.loadGuest(), false);
  globalThis.localStorage = ok;
});

test('borrar gustos con cuenta: se borra en el servidor y NO se restaura (B2)', async () => {
  const user = await reg('borra@x.com'); session.user = user; st.loadProfile(null);
  setBands(['Coldplay']); learn({ tags: ['genre:pop'] }, 4); P.favorites.push({ id: 'f1', title: 'x' }); await flush();
  const before = await serverProfile(); assert.deepEqual(before.bands, ['Coldplay']); assert.ok(before.rev >= 1);
  assert.equal(await st.resetProfile(), true);
  const after = await serverProfile();
  assert.deepEqual(after.bands, []); assert.deepEqual(after.favorites, []); assert.deepEqual(after.tags, {});
  assert.ok(after.rev > before.rev, 'queda una versión más nueva: un dispositivo viejo choca en vez de resucitar los datos');
  assert.deepEqual(P.bands, []); assert.equal(P.rev, after.rev);
  learn({ tags: ['genre:jazz'] }, 4); await flush(); // y se puede seguir guardando sin choques
  assert.ok((await serverProfile()).tags['genre:jazz']);
});
test('borrar gustos: si el servidor falla, no se vacía la pantalla ni se miente', async () => {
  setBands(['Muse']); await flush();
  offline = true; assert.equal(await st.resetProfile(), false); offline = false;
  assert.deepEqual(P.bands, ['Muse']);
});

test('dos dispositivos: el conflicto 409 se FUSIONA, no se descarta lo de este dispositivo (B3)', async () => {
  const user = await reg('dos@x.com'); session.user = user; st.loadProfile(null); events.length = 0;
  setBands(['Muse']); await flush();
  const base = await serverProfile();
  // «otro dispositivo» guarda directamente con la versión que conocía
  const other = { ...base, bands: ['Muse', 'Keane'], tags: { ...base.tags, 'genre:pop': [{ w: 3, t: Date.now() }] } };
  assert.equal((await raw('PUT', '/api/profile', { profile: other, base: base.rev })).status, 200);
  // este dispositivo, sin enterarse, cambia lo suyo y guarda con la versión vieja
  learn({ tags: ['genre:rock'] }, 4); setBands(['Muse', 'Travis']); await flush();
  const final = await serverProfile();
  assert.deepEqual(final.bands.sort(), ['Keane', 'Muse', 'Travis'], 'están las bandas de los dos');
  assert.ok(final.tags['genre:pop'] && final.tags['genre:rock'], 'están los puntajes de los dos');
  assert.ok(names().includes('pulso:conflict'), 'se avisa que se combinaron');
  assert.equal(P.rev, final.rev);
});

test('errores de guardado visibles (B4): sin conexión → aviso + reintento; al volver → «guardado»', async () => {
  const user = await reg('red@x.com'); session.user = user; st.loadProfile(null); events.length = 0;
  offline = true; setBands(['Sin red']); save(); st.retrySave();
  await until(() => names().includes('pulso:save-error'));
  assert.equal(events.find(e => e.type === 'pulso:save-error').detail.kind, 'offline');
  assert.equal(sync.dirty, true); assert.ok(mem.get('pulso:pending:v1'), 'queda respaldado en el navegador');
  offline = false; st.retrySave(); await until(() => !sync.dirty);
  assert.ok(names().includes('pulso:save-ok')); assert.equal(mem.get('pulso:pending:v1'), undefined);
  assert.deepEqual((await serverProfile()).bands, ['Sin red']);
});
test('errores de guardado: perfil demasiado grande (413) se avisa y no se reintenta en bucle', async () => {
  const user = await reg('grande@x.com'); session.user = user; st.loadProfile(null); events.length = 0;
  for (let i = 0; i < 700; i++) P.favorites.push({ id: 'f' + i, title: 'T'.repeat(300), subtitle: 'S'.repeat(300) });
  save(); st.retrySave(); await until(() => names().includes('pulso:save-error'));
  assert.equal(events.at(-1).detail.kind, 'too-big');
  P.favorites.length = 0; st.stopSync();
});
test('sesión vencida (401): se avisa, se respaldan los cambios y se recuperan al volver a entrar', async () => {
  const user = await reg('vence@x.com'); session.user = user; st.loadProfile(null); events.length = 0; mem.delete('pulso:pending:v1');
  setBands(['Muse']); await flush();
  const goodCookie = cookie; await raw('POST', '/api/auth/logout-all', {}, goodCookie); // la sesión deja de valer
  setBands(['Muse', 'Nueva']); save(); st.retrySave(); await until(() => names().includes('pulso:session-expired'));
  assert.ok(mem.get('pulso:pending:v1'));
  // vuelve a entrar con la misma cuenta
  const r = await raw('POST', '/api/auth/login', { email: 'vence@x.com', password: 'clave-segura' }, ''); cookie = r.headers.get('set-cookie').split(';')[0];
  const server = (await r.json()).profile; session.user = user; st.loadProfile(server);
  const back = st.recoverPending('vence@x.com', server); assert.deepEqual(back.bands.sort(), ['Muse', 'Nueva']);
  assert.equal(st.recoverPending('otra@x.com', server), null, 'no se mezcla con otra cuenta');
  setProfile(back); await flush(); assert.deepEqual((await serverProfile()).bands.sort(), ['Muse', 'Nueva']);
});
test.after(() => { st.stopSync(); setTimeout(() => process.exit(0), 50); });

// Fusión de perfiles de tres vías y filtro de contenido para adultos (funciones puras: no necesitan servidor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProfile } from '../public/js/merge.js';
import { isAdult, steamAdult, movieAdult, HIDE_EXPLICIT_SONGS } from '../public/js/shared.js';

const ev = (w, t) => ({ w, t });
const prof = o => ({ version: 1, rev: 0, onboardingDone: false, region: 'AR', adult: false, musicApp: '', tags: {}, bands: [], favorites: [], blocked: [], games: [], ...o });

test('fusión: lo que agregó cada dispositivo se conserva (nada se pierde)', () => {
  const base = prof({ rev: 3, bands: ['Muse'], tags: { 'genre:rock': [ev(4, 1)] } });
  const local = prof({ rev: 3, bands: ['Muse', 'Keane'], tags: { 'genre:rock': [ev(4, 1), ev(2, 5)] }, favorites: [{ id: 'a' }] });
  const server = prof({ rev: 4, bands: ['Muse', 'Travis'], tags: { 'genre:rock': [ev(4, 1), ev(1, 9)], 'genre:pop': [ev(3, 8)] }, favorites: [{ id: 'b' }] });
  const m = mergeProfile(base, local, server);
  assert.equal(m.rev, 4, 'queda la versión del servidor: el próximo guardado ya no choca');
  assert.deepEqual(m.bands.sort(), ['Keane', 'Muse', 'Travis']);
  assert.deepEqual(m.tags['genre:rock'].map(e => e.t), [1, 5, 9]);
  assert.deepEqual(m.tags['genre:pop'], [ev(3, 8)]);
  assert.deepEqual(m.favorites.map(f => f.id).sort(), ['a', 'b']);
});
test('fusión: lo que quitó este dispositivo se quita, y lo que quitó el otro también', () => {
  const base = prof({ bands: ['A', 'B', 'C'], favorites: [{ id: '1' }, { id: '2' }] });
  const local = prof({ bands: ['A', 'C'], favorites: [{ id: '1' }, { id: '2' }] }); // quitó B
  const server = prof({ rev: 2, bands: ['A', 'B'], favorites: [{ id: '2' }] }); // otro dispositivo quitó C y el favorito 1
  const m = mergeProfile(base, local, server);
  assert.deepEqual(m.bands, ['A']); assert.deepEqual(m.favorites, [{ id: '2' }]);
});
test('fusión: la compactación de eventos viejos no duplica el peso', () => {
  const base = prof({ tags: { t: [ev(1, 1), ev(1, 2), ev(1, 3)] } });
  const local = prof({ tags: { t: [ev(3, 3)] } }); // compactó los tres en uno
  const server = prof({ rev: 1, tags: { t: [ev(1, 1), ev(1, 2), ev(1, 3), ev(5, 9)] } });
  const m = mergeProfile(base, local, server);
  assert.equal(m.tags.t.reduce((a, e) => a + e.w, 0), 8, '3 (compactado) + 5 (del otro), no 3 + 3 + 5');
});
test('fusión: valores simples — si este dispositivo los cambió gana; si no, queda el del servidor', () => {
  const base = prof({ adult: false, musicApp: '' });
  const m = mergeProfile(base, prof({ adult: true }), prof({ rev: 2, musicApp: 'spotify' }));
  assert.equal(m.adult, true); assert.equal(m.musicApp, 'spotify');
  assert.equal(mergeProfile(base, prof({ onboardingDone: false }), prof({ onboardingDone: true })).onboardingDone, true);
});
test('fusión: sin base (primera vez) se unen los dos; entradas inválidas no la rompen', () => {
  const m = mergeProfile(null, prof({ bands: ['X'] }), prof({ bands: ['Y'], rev: 1 }));
  assert.deepEqual(m.bands.sort(), ['X', 'Y']);
  assert.doesNotThrow(() => mergeProfile(undefined, undefined, undefined));
});
test('fusión: respeta los topes del servidor', () => {
  const many = n => Array.from({ length: n }, (_, i) => ({ id: 'f' + i }));
  assert.equal(mergeProfile(prof(), prof({ favorites: many(600) }), prof({ rev: 1 })).favorites.length, 500);
  const evs = Array.from({ length: 80 }, (_, i) => ev(1, i));
  assert.equal(mergeProfile(prof(), prof({ tags: { t: evs } }), prof({ rev: 1 })).tags.t.length, 40);
});

// ---------- contenido para adultos ----------
test('adultos: ya no se esconden notas por falsos positivos (Gore Verbinski, acoso sexual)', () => {
  const news = title => ({ type: 'news', title });
  assert.equal(isAdult(news('Gore Verbinski dirigirá la nueva película')), false);
  assert.equal(isAdult(news('Denuncian acoso sexual en un estudio de juegos')), false);
  assert.equal(isAdult(news('Eliminan un juego con contenido sexual explícito de la tienda')), true);
  assert.equal(isAdult(news('New hentai game banned')), true);
});
test('adultos: Steam — edad 18 o descriptores sexuales (3 y 4); la violencia (2) no se oculta', () => {
  assert.equal(steamAdult({ required_age: '18' }), true);
  assert.equal(steamAdult({ content_descriptors: { ids: [4] } }), true);
  assert.equal(steamAdult({ content_descriptors: { ids: [3] } }), true);
  assert.equal(steamAdult({ content_descriptors: { ids: [2, 5] } }), false);
  assert.equal(steamAdult({}), false); assert.equal(steamAdult(undefined), false);
});
test('adultos: películas por clasificación (NC-17 sí, R no); canciones explícitas se marcan pero no se ocultan', () => {
  assert.equal(movieAdult('NC-17'), true); assert.equal(movieAdult('R'), false); assert.equal(movieAdult(undefined), false);
  assert.equal(isAdult({ type: 'movie', title: 'x', adult: true }), true);
  assert.equal(HIDE_EXPLICIT_SONGS, false);
  assert.equal(isAdult({ type: 'song', title: 'x', explicit: true }), false, 'esconderlas vaciaría el hip-hop de las listas');
});

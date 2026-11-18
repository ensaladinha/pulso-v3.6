// Fusión de perfiles de tres vías, para cuando dos dispositivos guardan a la vez (el servidor responde 409).
//
// Se parte de tres fotos:
//   base   = el perfil tal como lo conocía el servidor la última vez que este dispositivo se sincronizó;
//   local  = lo que hay ahora en este dispositivo (base + cambios hechos sin guardar);
//   server = lo que el servidor tiene ahora (base + cambios de otro dispositivo).
//
// Regla: se parte de lo del servidor y se le aplican los cambios locales, es decir, lo que este dispositivo
// AGREGÓ respecto de la base y lo que QUITÓ. Así no se pierde trabajo de ninguno de los dos lados.
// Función pura: no toca la red ni el DOM, por eso se prueba sola (test/merge.test.mjs).
import { normName } from './shared.js';

const MAX_EVENTS = 40, MAX_FAVORITES = 500, MAX_BLOCKED = 500, MAX_GAMES = 20, MAX_BANDS = 15;
const arr = v => (Array.isArray(v) ? v : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Fusión de tres vías de una lista de elementos con identidad (keyOf).
function mergeKeyed(base, local, server, keyOf) {
  const index = list => new Map(arr(list).map(x => [keyOf(x), x]));
  const b = index(base);
  const l = index(local);
  const out = index(server);
  for (const [key, value] of l) {
    if (!b.has(key) && !out.has(key)) out.set(key, value); // lo agregó este dispositivo
  }
  for (const key of b.keys()) {
    if (!l.has(key)) out.delete(key); // lo quitó este dispositivo
  }
  return [...out.values()];
}

const eventKey = e => `${e.w}|${e.t}`;

function mergeTags(base, local, server) {
  const tags = {};
  const names = new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(server || {})]);
  for (const name of names) {
    const events = mergeKeyed(base?.[name], local?.[name], server?.[name], eventKey)
      .sort((x, y) => x.t - y.t)
      .slice(-MAX_EVENTS);
    if (events.length) tags[name] = events;
  }
  return tags;
}

// Un valor simple (región, permiso de adultos, app de música…): si este dispositivo lo cambió, gana;
// si no, queda lo que haya guardado el servidor.
const pick = (key, base, local, server) => (same(local[key], base[key]) ? server[key] : local[key]);

export function mergeProfile(baseIn, localIn, serverIn) {
  const base = baseIn || {};
  const local = localIn || {};
  const server = serverIn || {};
  return {
    ...server,
    version: 1,
    rev: Number(server.rev) || 0,
    onboardingDone: !!(local.onboardingDone || server.onboardingDone),
    region: pick('region', base, local, server),
    adult: pick('adult', base, local, server) === true,
    musicApp: pick('musicApp', base, local, server) || '',
    tags: mergeTags(base.tags, local.tags, server.tags),
    bands: mergeKeyed(base.bands, local.bands, server.bands, normName).slice(0, MAX_BANDS),
    favorites: mergeKeyed(base.favorites, local.favorites, server.favorites, f => f.id).slice(-MAX_FAVORITES),
    blocked: mergeKeyed(base.blocked, local.blocked, server.blocked, id => id).slice(0, MAX_BLOCKED),
    games: mergeKeyed(base.games, local.games, server.games, g => g.id).slice(0, MAX_GAMES)
  };
}

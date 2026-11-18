// Estado del usuario: perfil de gustos (vive en la cuenta, en el servidor) y cómo aprende de cada interacción.
import { decay, weight } from './recommender.js';
import { mergeProfile } from './merge.js';
import { normName, tagLabel } from './shared.js';

export const session = { user: null };
export const ITEMS = new Map(); // id -> ítem mostrado (para resolver los clics de las tarjetas)
const fresh = () => ({ version: 1, onboardingDone: false, region: 'AR', tags: {}, bands: [], games: [], musicApp: '', adult: false, favorites: [], blocked: [] });
const arr = v => Array.isArray(v) ? v : [];
const clean = p => {
  const o = p && typeof p === 'object' ? p : {};
  return { ...fresh(), ...o, rev: Number(o.rev) || 0, tags: o.tags && typeof o.tags === 'object' && !Array.isArray(o.tags) ? o.tags : {},
    bands: arr(o.bands).filter(b => typeof b === 'string'), games: arr(o.games).filter(g => g && typeof g.id === 'string' && typeof g.title === 'string').map(g => ({ id: g.id, title: g.title, tags: arr(g.tags) })),
    adult: o.adult === true, musicApp: typeof o.musicApp === 'string' ? o.musicApp : '', favorites: arr(o.favorites), blocked: arr(o.blocked) };
};
// P es un único objeto compartido: se reemplaza su contenido, nunca la referencia, para que todos los módulos lo vean al día.
export const P = fresh();
export function setProfile(next) {
  for (const k of Object.keys(P)) delete P[k];
  Object.assign(P, clean(next));
}

// ---------- dónde vive el perfil ----------
// Con cuenta: en el servidor (PUT /api/profile). Sin cuenta: en este navegador (localStorage), para que elegir los gustos
// no se pierda al recargar. Todo acceso a localStorage va en try/catch: puede estar bloqueado (modo privado) o lleno.
const GUEST_KEY = 'pulso:guest:v1';
const PENDING_KEY = 'pulso:pending:v1';
const local = {
  read(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  clear(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
};
const emit = (name, detail) => {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(name, { detail }));
  } catch {}
};
const snapshot = () => JSON.parse(JSON.stringify(P));

// Perfil del invitado guardado en este navegador (o null).
export function loadGuest() {
  const saved = local.read(GUEST_KEY);
  if (saved && typeof saved === 'object') setProfile(saved);
  return !!saved;
}
export const clearGuest = () => local.clear(GUEST_KEY);

// ---------- sincronización con el servidor ----------
// El servidor numera cada versión (P.rev). Si otro dispositivo guardó antes, rechaza la escritura vieja (409) y acá los dos
// perfiles se FUSIONAN (ver merge.js) en vez de descartar lo hecho en este dispositivo.
let synced = null; // copia del perfil tal como lo tiene el servidor: es la base de la fusión
export const sync = { dirty: false, error: null };
let saveTimer = null;
let retryTimer = null;
let retries = 0;
let inflight = false;
let again = false;
let notified = false;
const RETRY_MS = [5000, 15000, 45000, 120000];

// Adopta un perfil que vino del servidor (acceso, /auth/me, borrado) y lo recuerda como base de la fusión.
export function loadProfile(fromServer) {
  setProfile(fromServer);
  synced = fromServer ? snapshot() : null;
  sync.dirty = false;
  sync.error = null;
}
export const hasUnsaved = () => !!session.user && sync.dirty;

// Cambios sin guardar de una visita anterior (se cerró la pestaña sin conexión, o la sesión venció): se respaldan en este
// navegador y, al volver a entrar con la MISMA cuenta, se fusionan con lo que haya en el servidor.
const writePending = () => session.user && local.write(PENDING_KEY, { email: session.user.email, base: synced, profile: snapshot() });
export const clearPending = () => local.clear(PENDING_KEY);
export function recoverPending(email, serverProfile) {
  const saved = local.read(PENDING_KEY);
  if (!saved || saved.email !== email || !saved.profile) return null;
  return mergeProfile(saved.base, saved.profile, serverProfile);
}

function failed(kind, retry) {
  sync.error = kind;
  writePending();
  if (!notified) {
    notified = true;
    emit('pulso:save-error', { kind });
  }
  if (retry && retries < RETRY_MS.length + 4) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(push, RETRY_MS[Math.min(retries, RETRY_MS.length - 1)]);
    retries++;
  }
}

async function push() {
  if (!session.user) return;
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sent = snapshot();
      let r;
      try {
        r = await fetch('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: sent, base: sent.rev || 0 }),
          signal: AbortSignal.timeout(15000)
        });
      } catch {
        return failed('offline', true); // sin red o sin respuesta: se reintenta solo
      }
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        P.rev = d.rev;
        synced = { ...sent, rev: d.rev };
        retries = 0;
        if (!again) {
          sync.dirty = false;
          sync.error = null;
          clearPending();
        }
        if (notified) {
          notified = false;
          emit('pulso:save-ok');
        }
        if (attempt > 0) emit('pulso:conflict', { merged: true });
        return;
      }
      if (r.status === 409 && d.profile) {
        // Otro dispositivo guardó primero: se combinan los dos y se reintenta enseguida con la versión nueva.
        const merged = mergeProfile(synced, snapshot(), d.profile);
        synced = d.profile;
        setProfile(merged);
        continue;
      }
      if (r.status === 401) {
        sync.error = 'session';
        writePending();
        emit('pulso:session-expired');
        return;
      }
      if (r.status === 413) return failed('too-big', false);
      return failed(r.status >= 500 || r.status === 429 ? 'server' : 'rejected', r.status >= 500 || r.status === 429);
    }
    failed('conflict', true); // tres choques seguidos: raro, se reintenta más tarde
  } finally {
    inflight = false;
    if (again) {
      again = false;
      save();
    }
  }
}

export function save() {
  // Sin cuenta: se guarda en este navegador, al instante. Con cuenta: en el servidor, 0,8 s después del último cambio.
  if (!session.user) {
    local.write(GUEST_KEY, snapshot());
    return;
  }
  sync.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(push, 800);
}
// Para reintentar ya (p. ej. al volver la conexión).
export function retrySave() {
  if (hasUnsaved() && !inflight) {
    retries = 0;
    clearTimeout(retryTimer);
    push();
  }
}
// Al salir de la sesión: se frena todo lo pendiente y se borran los respaldos locales.
export function stopSync() {
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  retries = 0;
  again = false;
  synced = null;
  sync.dirty = false;
  sync.error = null;
  notified = false;
  clearPending();
  clearGuest();
}

// «Borrar mis gustos y favoritos»: con cuenta se borra en el servidor (DELETE /api/profile). Antes se mandaba un perfil vacío
// con la versión 0, el servidor lo tomaba como un guardado viejo (409) y el cliente restauraba todo. Devuelve true si se borró.
export async function resetProfile() {
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  if (!session.user) {
    setProfile(null);
    clearGuest();
    return true;
  }
  try {
    const r = await fetch('/api/profile', { method: 'DELETE', signal: AbortSignal.timeout(15000) });
    if (r.status === 401) {
      emit('pulso:session-expired');
      return false;
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.profile) return false;
    loadProfile(d.profile);
    clearPending();
    return true;
  } catch {
    return false;
  }
}
export const addEvent = (tag, w) => (P.tags[tag] ??= []).push({ w, t: Date.now() });

// Cada interacción suma o resta peso a las etiquetas del ítem (género, artista, plataforma…): así el perfil se afina solo.
// Pesos: me gusta +4 · terminar una canción +2 · reproducir/abrir +1/+2 · saltar −1 · "no me interesa" −4.
export function learn(item, w) {
  for (const t of item?.tags || []) {
    const events = (P.tags[t] ??= []);
    events.push({ w, t: Date.now() });
    if (events.length > 40) { // compacta el historial viejo en un solo evento equivalente
      const old = events.splice(0, events.length - 20), at = old.at(-1).t;
      events.unshift({ w: old.reduce((a, e) => a + decay(e.w, e.t, at), 0), t: at });
    }
  }
  save();
}

// Bandas: se guardan con su nombre y suman peso fuerte a su etiqueta de artista (+8).
export function setBands(next) {
  const was = new Set(P.bands.map(normName)), now = new Map(next.map(b => [normName(b), b]));
  for (const n of now.keys()) if (!was.has(n)) addEvent('artist:' + n, 8);
  for (const n of was) if (!now.has(n)) addEvent('artist:' + n, -Math.max(0, weight('artist:' + n, P)));
  P.bands = [...now.values()]; save();
}

// Juegos que la persona cargó a mano ({ id, title, tags }): suman peso a sus géneros/plataformas, igual que las bandas a sus artistas.
export function setGames(next) {
  const was = new Map(P.games.map(g => [g.id, g])), now = new Map(next.map(g => [g.id, g]));
  for (const [id, g] of now) if (!was.has(id)) for (const t of g.tags) addEvent(t, 3);
  for (const [id, g] of was) if (!now.has(id)) for (const t of g.tags) addEvent(t, -3);
  P.games = [...now.values()]; save();
}

// Etiquetas con peso positivo bajo un prefijo, de mayor a menor: [[clave, peso], …]
export const topWeights = (prefix, n, min = 0.5) =>
  Object.keys(P.tags).filter(k => k.startsWith(prefix)).map(k => [k.slice(prefix.length), weight(k, P)])
    .filter(x => x[1] > min).sort((a, b) => b[1] - a[1]).slice(0, n);
export const topKeys = (prefix, n, min) => topWeights(prefix, n, min).map(x => x[0]);

// Etiqueta -> texto legible. Los artistas usan el nombre tal como lo escribió la persona.
const OVERRIDES = { soundtrack: 'Banda sonora', 'música latina': 'Latino', 'singer/songwriter': 'Cantautor' };
const titleCase = t => String(t).replace(/(^|\s)\S/g, c => c.toUpperCase());
export function label(tag) {
  const name = tag.split(':').slice(1).join(':');
  if (tag.startsWith('artist:')) return P.bands.find(b => normName(b) === name) || titleCase(name);
  return OVERRIDES[name] || tagLabel(tag);
}
export const list = tags => tags.map(label).join(', ');

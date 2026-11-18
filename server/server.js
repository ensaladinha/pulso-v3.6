import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { songTags, steamGenreTag, steamAdult, movieAdult, gameTagsFromText, mediaGenreTags } from '../public/js/shared.js';
import { registerPersonal } from './personal.js';
import { createStore } from './store.js';
try { process.loadEnvFile(); } catch {} // .env solo existe en tu PC (Node 22 lo lee solo); en Vercel las variables vienen del panel
const { YT_KEY, PORT = 3000, TRUST_PROXY, NODE_ENV, RESEND_API_KEY, MAIL_FROM, APP_URL } = process.env;
const YT_MUSIC = !!YT_KEY && process.env.YT_MUSIC === '1'; // la música completa en YouTube gasta ~100 búsquedas/día de cuota: solo si se activa a propósito
const DB_FILE = process.env.DB_FILE || (process.env.VERCEL ? '/tmp/pulso-db.json' : path.join(import.meta.dirname, '../data/db.json')); // Vercel solo deja escribir en /tmp (temporal)
const store = createStore({ file: DB_FILE });
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

// ---- cabeceras de seguridad (sin dependencias externas) ----
// CSP: solo scripts propios y la API de YouTube; sin estilos ni manejadores en línea.
const CSP = [
  "default-src 'self'", "script-src 'self' https://www.youtube.com https://s.ytimg.com", "style-src 'self'",
  "img-src 'self' data: https:", "media-src https:", "connect-src 'self'",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin', // YouTube exige referrer para incrustar
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'Cross-Origin-Opener-Policy': 'same-origin'
  });
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});
// Defensa extra contra CSRF: una petición que cambia datos solo se acepta si viene de este mismo sitio.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const o = req.headers.origin, site = req.headers['sec-fetch-site'];
  // Sin Origin solo pasa quien no es un navegador (curl, pruebas) o un navegador que dice "mismo sitio"/"ninguno".
  if (!o && (!site || site === 'same-origin' || site === 'none')) return next();
  try { if (o && new URL(o).host === req.headers.host) return next(); } catch {}
  res.status(403).json({ error: 'Origen no permitido' });
});

// ---- caché en memoria con TTL (segundos o función del valor) y deduplicación de pedidos en curso ----
// Nivel 1: memoria de la instancia. Nivel 2 (solo con Redis): compartido entre instancias, así una instancia nueva no arranca "en frío".
// Servir lo viejo ante un error (stale-on-error): un dato vencido NO se descarta enseguida. Si la fuente externa falla,
// se sigue sirviendo el último dato bueno hasta STALE_S segundos después de vencer, en vez de devolver un 502 a todos.
const cache = new Map(), pending = new Map();
const STALE_S = 6 * 3600;
const stale = new WeakSet(); // valores que se están sirviendo vencidos porque la fuente falló (para avisarlo)
const isStale = v => typeof v === 'object' && v !== null && stale.has(v);
const ttlOf = (ttl, v) => typeof ttl === 'function' ? ttl(v) : ttl;
function remember(key, v, secs, until = Date.now() + (secs + STALE_S) * 1000) {
  if (cache.size >= 2000) { // tope de memoria: primero lo que ya no sirve ni vencido, después lo más viejo
    for (const [k, e] of cache) if (e.until <= Date.now()) cache.delete(k);
    if (cache.size >= 2000) for (const k of [...cache.keys()].slice(0, 400)) cache.delete(k);
  }
  cache.set(key, { v, exp: Date.now() + secs * 1000, until });
  return v;
}
async function cached(key, ttl, fn) {
  const h = cache.get(key);
  if (h && h.exp > Date.now()) return h.v;
  if (pending.has(key)) return pending.get(key); // 50 pedidos iguales a la vez = 1 pedido a la API externa
  const p = (async () => {
    let fallback = h && h.until > Date.now() ? h : null; // vencido pero todavía usable si la fuente falla
    const got = await store.cacheGet(key).catch(() => null);
    const shared = got && typeof got === 'object' && 'v' in got && 'exp' in got ? got : null; // formato {v, exp}; lo anterior se ignora
    if (shared && shared.exp > Date.now()) return remember(key, shared.v, Math.min(300, (shared.exp - Date.now()) / 1000)); // de Redis: se recuerda poco en memoria para no desfasarse
    if (!fallback && shared) fallback = { v: shared.v, until: shared.exp + STALE_S * 1000 };
    try {
      const v = await fn(), secs = ttlOf(ttl, v);
      store.cacheSet(key, { v, exp: Date.now() + secs * 1000 }, secs + STALE_S).catch(() => {}); // en Redis vive más que su "frescura", para poder servirlo vencido
      return remember(key, v, secs);
    } catch (e) {
      if (!fallback) throw e;
      console.error(`[stale] ${key}: ${e.message}; se sirve el dato anterior`);
      if (typeof fallback.v === 'object' && fallback.v !== null) stale.add(fallback.v);
      return remember(key, fallback.v, 60, fallback.until); // se reintenta en 1 minuto, no en cada pedido; no se alarga el plazo total
    }
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}
// ---- límite de peticiones por IP (ventana deslizante); las tablas se limpian solas ----
const limiters = [];
function limiter(max, windowMs, message = 'Demasiadas peticiones') {
  const hits = new Map(); limiters.push([hits, windowMs]);
  return (req, res, next) => {
    const now = Date.now(), h = (hits.get(req.ip) || []).filter(t => now - t < windowMs);
    h.push(now); hits.set(req.ip, h);
    h.length > max ? res.status(429).set('Retry-After', Math.ceil(windowMs / 1000)).json({ error: message }) : next();
  };
}
setInterval(() => { const now = Date.now(); for (const [m, w] of limiters) for (const [ip, h] of m) if (!h.some(t => now - t < w)) m.delete(ip); }, 60000).unref();
// Límite compartido entre instancias (Redis): ventana fija por IP. La IP no se guarda en claro: la clave lleva su hash.
// Qué pasa si el almacenamiento falla es una decisión por ruta (failOpen):
//  - contenido (búsquedas, tráilers): se deja pasar; peor sería dejar a todos sin la página por una caída de Redis;
//  - cuentas (registro, acceso, recuperación): se rechaza con 503; sin límite, una caída permitiría probar contraseñas sin freno.
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function sharedLimiter(name, max, windowMs, message = 'Demasiadas peticiones', { failOpen = true } = {}) {
  return async (req, res, next) => {
    try {
      const n = await store.incr(`${name}:${sha(String(req.ip)).slice(0, 24)}:${Math.floor(Date.now() / windowMs)}`, Math.ceil(windowMs / 1000) + 5);
      if (n > max) return res.status(429).set('Retry-After', Math.ceil(windowMs / 1000)).json({ error: message });
    } catch (e) {
      console.error('[limit]', e.message);
      if (!failOpen) return res.status(503).json({ error: 'El servicio no está disponible un momento, probá de nuevo en unos minutos' });
    }
    next();
  };
}
// Freno general barato (por instancia: solo frena ráfagas); lo que protege dinero y cuentas usa el límite compartido.
app.use('/api', limiter(120, 60000));
// Las rutas que gastan cuota de YouTube tienen un límite mucho más bajo
app.use(['/api/music/resolve', '/api/trailer'], sharedLimiter('video', 20, 60000, 'Demasiadas búsquedas de video, esperá un momento'));
// Cada texto distinto de búsqueda es una llamada a iTunes/Steam/TVmaze (y iTunes limita por IP de salida, compartida por todos):
// sin un tope compartido, alguien podría gastar ese cupo para todos los usuarios.
app.use(['/api/music/search', '/api/games/search', '/api/media/search'], sharedLimiter('search', 40, 60000, 'Demasiadas búsquedas, esperá un momento'));
app.use(['/api/music/artists', '/api/music/similar'], sharedLimiter('names', 40, 60000, 'Demasiados pedidos, esperá un momento'));
// Datos personales: nunca se guardan en cachés intermedias ni del navegador.
app.use(['/api/auth', '/api/profile'], (_q, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const j = async u => { const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Pulso/1.0' } }); if (!r.ok) throw new Error('API ' + r.status); return r.json(); };
const need = (k, n) => { if (!k) throw new Error('Falta ' + n + ' en .env'); };
// keys: los únicos parámetros que forman la llave de caché ([] si la ruta no recibe ninguno).
// Así "&x=1" nunca genera entradas nuevas ni pedidos extra a las APIs externas.
// Cada valor se normaliza ANTES de cachear y de llamar a la fuente (espacios, mayúsculas, Unicode): "Muse", "muse " y "MUSE" son un solo pedido.
const normQuery = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
const route = (p, ttl, fn, keys = []) => app.get(p, async (req, res) => {
  const query = Object.fromEntries(keys.map(k => [k, normQuery(req.query[k])]));
  const key = p + '?' + keys.map(k => query[k]).join('&');
  try {
    const v = await cached(key, ttl, () => fn({ query }));
    if (isStale(v)) { // la fuente falló y se sirve el último dato bueno: que ni el CDN ni el navegador lo guarden mucho
      res.set('Cache-Control', 'public, max-age=30, s-maxage=30').set('X-Pulso-Fallback', 'stale');
    } else {
      res.set('Cache-Control', `public, max-age=60, s-maxage=${Math.min(ttlOf(ttl, v), 3600)}, stale-while-revalidate=600`); // el CDN (p. ej. Vercel) también la guarda
    }
    res.json(v);
  }
  catch (e) { console.error(`[${p}]`, e.message); res.status(502).json({ error: 'No se pudo obtener el contenido ahora' }); }
});
const H = 3600, D = 86400;
const ytSearch = async q => { // devuelve un videoId; si YouTube falla (cuota agotada, etc.) se recuerda 10 min en vez de reintentar
  try { const d = await j(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(q)}&key=${YT_KEY}`); return { videoId: d.items?.[0]?.id?.videoId || null }; }
  catch (e) { console.error('[youtube]', e.message); return { videoId: null, failed: true }; }
};
const ytTtl = v => v.failed ? 600 : v.videoId ? 30 * D : D;

// ---- Música (iTunes, sin clave) ----
const song = t => ({ id: 'itunes:' + t.trackId, type: 'song', title: t.trackName, artist: t.artistName,
  subtitle: t.artistName, image: (t.artworkUrl100 || '').replace('100x100', '300x300'),
  tags: songTags(t.artistName, t.primaryGenreName), popularity: 0.5, previewUrl: t.previewUrl,
  ...(t.trackExplicitness === 'explicit' ? { explicit: true } : {}) }); // se marca; no se oculta por defecto (ver HIDE_EXPLICIT_SONGS en shared.js)
route('/api/music/search', H, async r => {
  const q = String(r.query.q || '').slice(0, 80); if (!q) return [];
  const d = await j(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=20&country=AR`);
  return d.results.map(song);
}, ['q']);
// Entrada del ranking RSS de iTunes -> canción
const chartSong = (x, i, e) => ({ id: 'itunes:' + x.id.attributes['im:id'], type: 'song', title: x['im:name'].label,
  artist: x['im:artist'].label, subtitle: x['im:artist'].label, image: [].concat(x['im:image']).pop().label.replace('170x170', '300x300'),
  tags: songTags(x['im:artist'].label, x.category?.attributes?.term), popularity: 1 - i / e.length,
  publishedAt: Date.parse(x['im:releaseDate']?.label) || undefined, previewUrl: [].concat(x.link || [])[1]?.attributes?.href });
const chartSongs = d => { const e = [].concat(d.feed?.entry || []); return e.map((x, i) => chartSong(x, i, e)); };
const musicCharts = async () => chartSongs(await j('https://itunes.apple.com/ar/rss/topsongs/limit=20/json'));
route('/api/music/charts', 6 * H, musicCharts);
route('/api/music/resolve', ytTtl, r => { // canción -> videoId de YouTube
  if (!YT_MUSIC) throw new Error('Música completa desactivada (YT_MUSIC)');
  return ytSearch(`${String(r.query.artist || '').slice(0, 60)} ${String(r.query.title || '').slice(0, 60)}`.trim());
}, ['artist', 'title']);

app.get('/api/config', (_q, res) => res.json({ yt: !!YT_KEY, ytMusic: YT_MUSIC })); // yt = tráilers; ytMusic = canción completa embebida
route('/api/trailer', ytTtl, r => { // título -> videoId del tráiler
  need(YT_KEY, 'YT_KEY');
  return ytSearch(`${String(r.query.q || '').slice(0, 100)} tráiler oficial`);
}, ['q']);

// ---- Normalización común ----
// Texto plano. Los anuncios de comunidad de Steam vienen en BBCode ([h1], [img]…[/img], [url=…]), no en HTML:
// se quitan las imágenes y las etiquetas, y también una etiqueta cortada al final (el texto llega truncado por el largo máximo).
const strip = s => String(s || '')
  .replace(/\[img\][\s\S]*?(?:\[\/img\]|$)/gi, ' ')
  .replace(/\{STEAM_CLAN_IMAGE\}\S*/g, ' ')
  .replace(/\[\/?[a-z][a-z0-9]*(?:=[^\]]*)?\]|\[\*\]/gi, ' ')
  .replace(/\[[^\]]*$/, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const art = u => (u || '').replace(/\/\d+x\d+(bb)?\./, '/300x450bb.');
const normGenre = mediaGenreTags; // etiquetas mediagenre:* (series y películas)

// ---- Películas: iTunes (público, sin clave; trae tráiler de Apple) ----
const movieFrom = x => ({ id: 'itunes:movie:' + x.trackId, type: 'movie', title: x.trackName,
  subtitle: [(x.releaseDate || '').slice(0, 4), x.primaryGenreName].filter(Boolean).join(' · '), image: art(x.artworkUrl100),
  tags: normGenre(x.primaryGenreName), popularity: 0.5, publishedAt: Date.parse(x.releaseDate) || undefined,
  trailerUrl: x.previewUrl, sourceUrl: x.trackViewUrl, ...(movieAdult(x.contentAdvisoryRating) ? { adult: true } : {}) });
const topMovies = () => cached('topmovies', 6 * H, async () => {
  const d = await j('https://itunes.apple.com/ar/rss/topmovies/limit=20/json'), e = d.feed.entry || [];
  return e.map((x, i) => { const L = [].concat(x.link || []), rd = x['im:releaseDate']?.label, c = x.category?.attributes || {};
    return { id: 'itunes:movie:' + x.id.attributes['im:id'], type: 'movie', title: x['im:name'].label,
      subtitle: [(rd || '').slice(0, 4), c.label].filter(Boolean).join(' · '), image: art([].concat(x['im:image']).pop().label),
      tags: normGenre((c.term || '') + ' ' + (c.label || '')), popularity: 1 - i / e.length, publishedAt: Date.parse(rd) || undefined,
      trailerUrl: L.find(l => l.attributes?.rel === 'enclosure')?.attributes.href, sourceUrl: L[0]?.attributes?.href }; });
});

// ---- Series: TVmaze (público, sin clave) ----
const show = s => ({ id: 'tvmaze:' + s.id, type: 'series', title: s.name,
  subtitle: [(s.premiered || '').slice(0, 4), s.rating?.average ? '★ ' + s.rating.average : '', s.webChannel?.name || s.network?.name].filter(Boolean).join(' · '),
  image: s.image?.medium || '', tags: [...new Set([...(s.genres || []), s.type].flatMap(normGenre))], popularity: Math.min(1, (s.weight || 0) / 100),
  publishedAt: s.premiered ? Date.parse(s.premiered) : undefined, sourceUrl: s.officialSite || s.url });
const schedule = () => cached('sched', 3 * H, async () => {
  const eps = await j(`https://api.tvmaze.com/schedule/web?date=${new Date().toISOString().slice(0, 10)}`), seen = new Map();
  for (const e of eps) { const s = e._embedded?.show || e.show; if (s && !seen.has(s.id)) seen.set(s.id, { s, prem: e.number === 1 ? 1 : 0 }); }
  const all = [...seen.values()], pref = all.filter(v => ['English', 'Spanish'].includes(v.s.language));
  return pref.length >= 6 ? pref : all;
});
route('/api/media/search', H, async r => {
  const q = encodeURIComponent(String(r.query.q || '').slice(0, 80)); if (!q) return [];
  const [a, b] = await Promise.allSettled([j(`https://api.tvmaze.com/search/shows?q=${q}`), j(`https://itunes.apple.com/search?term=${q}&media=movie&entity=movie&country=AR&limit=12`)]);
  if (a.status === 'rejected' && b.status === 'rejected') throw new Error('Sin respuesta');
  return [...(a.value || []).slice(0, 10).map(x => show(x.show)), ...(b.value?.results || []).map(movieFrom)];
}, ['q']);
const mediaNew = async () => {
  const sc = (await schedule()).sort((x, y) => (y.prem - x.prem) || ((y.s.weight || 0) - (x.s.weight || 0))).slice(0, 10).map(x => show(x.s));
  const mv = [...await topMovies()].sort((x, y) => (y.publishedAt || 0) - (x.publishedAt || 0)).slice(0, 10);
  return [...sc, ...mv];
};
route('/api/media/new', 3 * H, mediaNew);
const mediaTrending = async () => {
  const sc = (await schedule()).sort((x, y) => (y.s.weight || 0) - (x.s.weight || 0)).slice(0, 10).map(x => show(x.s));
  return [...(await topMovies()).slice(0, 10), ...sc];
};
route('/api/media/trending', 3 * H, mediaTrending);

// ---- Videojuegos: Steam (tienda y noticias públicas, sin clave) ----
const tagText = gameTagsFromText; // etiquetas gamegenre:* y platform:* a partir de un texto
const ST = 'https://store.steampowered.com/api', hdr = id => `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`;
const featured = () => cached('feat', H, () => j(`${ST}/featuredcategories?cc=ar&l=spanish`));
// Solo se guardan los campos que Pulso usa: la respuesta completa de appdetails trae capturas, descripciones largas, requisitos, etc.
const slimInfo = d => ({ name: d.name, release_date: d.release_date, is_free: d.is_free, price_overview: d.price_overview && { final_formatted: d.price_overview.final_formatted },
  header_image: d.header_image, genres: (d.genres || []).map(g => ({ description: g.description })), short_description: (d.short_description || '').slice(0, 300),
  recommendations: d.recommendations && { total: d.recommendations.total }, required_age: d.required_age, content_descriptors: { ids: d.content_descriptors?.ids || [] } });
const gameInfo = id => cached('app' + id, D, async () => {
  const x = (await j(`${ST}/appdetails?appids=${id}&l=spanish&cc=ar`))[id]; if (!x?.success) throw new Error('sin datos'); return slimInfo(x.data); });
const gameFrom = (id, name, d, img) => { const rd = d?.release_date?.date, nm = d?.name || name;
  const adult = steamAdult(d); // edad requerida 18+ o descriptores 3/4 (contenido sexual); ver shared.js
  return { ...(adult ? { adult: true } : {}), id: 'steam:' + id, type: 'game', title: nm, subtitle: [rd, d?.is_free ? 'Gratis' : d?.price_overview?.final_formatted].filter(Boolean).join(' · '),
    image: d?.header_image || img || hdr(id), tags: [...new Set([...(d?.genres || []).map(g => steamGenreTag(g.description)), 'platform:pc', ...tagText(nm + ' ' + (d?.short_description || ''))])],
    popularity: Math.min(1, (d?.recommendations?.total || 0) / 200000), publishedAt: Date.parse(rd) || undefined, sourceUrl: 'https://store.steampowered.com/app/' + id }; };
const enrich = async items => (await Promise.all(items.map(async i => gameFrom(i.id, i.name, await gameInfo(i.id).catch(() => null), i.header_image || i.large_capsule_image))));
const gamesUpcoming = async () => enrich(((await featured()).coming_soon?.items || []).filter(i => i.id).slice(0, 12));
const gamesTrending = async () => enrich(((await featured()).top_sellers?.items || []).filter(i => i.id).slice(0, 5));
route('/api/games/upcoming', 6 * H, gamesUpcoming);
route('/api/games/trending', 6 * H, gamesTrending);
route('/api/games/search', H, async r => { const q = encodeURIComponent(String(r.query.q || '').slice(0, 80)); if (!q) return [];
  const d = await j(`${ST}/storesearch/?term=${q}&l=spanish&cc=AR`); return enrich((d.items || []).filter(i => i.type === 'app').slice(0, 10)); }, ['q']);
// Filtros de calidad: sin cirílico/chino/árabe, sin avisos internos de Steam, sin títulos cortos o numéricos
const BAD_SCRIPT = /[\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;
const BAD_NEWS = /steam\s?(client|deck|os|frame|link|controller|machine)|steamos|\bbeta\b|hotfix|patch notes?|maintenance/i;
const okNews = x => { const t = (x.title || '').trim();
  return t.length >= 15 && !BAD_SCRIPT.test(t) && !BAD_NEWS.test(t) && !/^[\d\s.,%$]+$/.test(t); };
const gamesNews = async () => { // anuncios oficiales de los juegos del momento (Steam News), 1 por juego
  const f = await featured(), seen = new Set(), games = [];
  for (const i of [...(f.top_sellers?.items || []), ...(f.new_releases?.items || []), ...(f.specials?.items || [])])
    if (i.id && !seen.has(i.id) && !/^steam\b|valve/i.test(i.name || '')) { seen.add(i.id); games.push(i); }
  const list = games.slice(0, 14);
  const per = await Promise.all(list.map(async (g, gi) => {
    const [n, info] = await Promise.all([j(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${g.id}&count=10&maxlength=1000&format=json`).catch(() => null), gameInfo(g.id).catch(() => null)]);
    const items = (n?.appnews?.newsitems || []).filter(okNews);
    const x = items.find(v => v.feed_type === 1 || v.feedname === 'steam_community_announcements') || items[0];
    if (!x) return [];
    return [{ id: 'news:' + x.gid, type: 'news', title: x.title.trim(),
      subtitle: `${info?.name || g.name} · ${x.feedlabel}`, // la fecha (publishedAt) la formatea el navegador según su zona e idioma
      image: info?.header_image || g.header_image || g.large_capsule_image || hdr(g.id), summary: strip(x.contents).slice(0, 300),
      tags: [...new Set([...gameFrom(g.id, g.name, info).tags, ...tagText(x.title)])], popularity: 1 - gi / list.length, publishedAt: x.date * 1000, sourceUrl: x.url, ...(gameFrom(g.id, g.name, info).adult ? { adult: true } : {}) }];
  }));
  const titles = new Set();
  return per.flat().filter(n => { const k = n.title.toLowerCase().slice(0, 24); if (titles.has(k)) return false; titles.add(k); return true; })
    .sort((a, b) => b.publishedAt - a.publishedAt);
};
route('/api/games/news', 20 * 60, gamesNews);

// ---- Portada en un solo pedido: las 6 listas base + la hora real en que se armó. Comparte caché con las rutas individuales. ----
// Cada lista que falla queda en null y se nombra en `failed`, así la pantalla puede decir qué fuente no respondió.
const HOME_PARTS = [['charts', 'music/charts', 6 * H, musicCharts, 'Música (iTunes)'], ['news', 'games/news', 20 * 60, gamesNews, 'Noticias de juegos (Steam)'], 
  ['trending', 'media/trending', 3 * H, mediaTrending, 'Series y películas'], ['fresh', 'media/new', 3 * H, mediaNew, 'Estrenos de series y películas'], 
  ['upcoming', 'games/upcoming', 6 * H, gamesUpcoming, 'Lanzamientos de juegos (Steam)'], ['hot', 'games/trending', 6 * H, gamesTrending, 'Juegos más vendidos (Steam)']];
route('/api/home', v => (v.failed.length || v.stale.length ? 60 : 20 * 60), async () => {
  const res = await Promise.allSettled(HOME_PARTS.map(([, p, ttl, fn]) => cached(`/api/${p}?`, ttl, fn))), lists = {}, failed = [], old = [];
  HOME_PARTS.forEach(([k, , , , name], i) => {
    lists[k] = res[i].status === 'fulfilled' ? res[i].value : null;
    if (res[i].status === 'rejected') failed.push(name);
    else if (isStale(res[i].value)) old.push(name); // la fuente no respondió y se muestra el último dato bueno
  });
  if (failed.length === HOME_PARTS.length) throw new Error('Sin respuesta de ninguna fuente');
  return { generatedAt: Date.now(), failed, stale: old, ...lists };
});


// ---- Cuentas: contraseña con scrypt + sesión en cookie HttpOnly. El guardado lo resuelve server/store.js ----
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => e ? no(e) : ok(k)));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, DAYS30 = 30 * 864e5, MIN_PW = 8;
const DUMMY_SALT = crypto.randomBytes(16).toString('hex'); // para que un email inexistente tarde lo mismo que uno real
const sidOf = req => /(?:^|;\s*)pulso_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
// Devuelve el email de la sesión vigente o null.
const me = async req => {
  const c = sidOf(req); if (!c) return null;
  const s = await store.getSession(sha(c));
  return s && s.exp > Date.now() && await store.getUser(s.uid) ? s.uid : null;
};
const cookie = (req, v, age) => `pulso_sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${req.headers['x-forwarded-proto'] === 'https' || req.secure ? '; Secure' : ''}`;
const publicUser = (email, u) => ({ email, name: u.name });
async function startSession(req, res, email) {
  const t = crypto.randomBytes(32).toString('hex');
  await store.putSession(sha(t), { uid: email, exp: Date.now() + DAYS30 });
  res.setHeader('Set-Cookie', cookie(req, t, DAYS30 / 1000));
}
// Intentos fallidos de acceso, contados en el almacenamiento compartido (Redis) para que cambiar de instancia no reinicie el contador.
// Antes eran 10 fallos por email desde cualquier IP: bastaba mandar 10 contraseñas malas para dejar a la víctima fuera de su cuenta.
// Ahora, en ventanas de 15 min:
//  - por par (IP + email): 10 fallos -> bloqueo. Quien ataca solo bloquea su propia IP contra esa cuenta; la dueña, desde otra IP, entra;
//  - por IP: 40 fallos en total (probar muchas cuentas desde un lugar). Es más alto porque muchas operadoras móviles comparten una IP;
//  - por email, desde cualquier IP: no bloquea; frena con una demora creciente (el ataque distribuido se vuelve lento sin dejar afuera a la dueña);
//    y si pasa de 200 fallos, bloquea (tope duro para que no sea un intento ilimitado).
const FAIL_PAIR = 10, FAIL_IP = 40, FAIL_ACCOUNT_SLOW = 5, FAIL_ACCOUNT_CAP = 200;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failKeys = (ip, email) => {
  const b = Math.floor(Date.now() / 9e5), i = sha(String(ip)).slice(0, 24), e = sha(email || '-').slice(0, 24);
  return [`lf:pair:${i}:${e}:${b}`, `lf:ip:${i}:${b}`, `lf:em:${e}:${b}`];
};
// Lanza si el almacenamiento falla: en cuentas se falla cerrado (503), no se deja probar contraseñas sin freno.
async function loginGuard(ip, email) {
  const [pair, byIp, account] = await Promise.all(failKeys(ip, email).map(k => store.count(k)));
  return { blocked: pair >= FAIL_PAIR || byIp >= FAIL_IP || account >= FAIL_ACCOUNT_CAP, delayMs: account > FAIL_ACCOUNT_SLOW ? Math.min(3000, (account - FAIL_ACCOUNT_SLOW) * 150) : 0 };
}
const addFail = async (ip, email) => { try { await Promise.all(failKeys(ip, email).map(k => store.incr(k, 900 + 5))); } catch (e) { console.error('[limit]', e.message); } };
const UNAVAILABLE = 'Error: el servicio no está disponible un momento, probá de nuevo en unos minutos';
// Devuelve true si la petición debe cortarse (y ya respondió).
async function guarded(req, res, email, field) {
  let g;
  try { g = await loginGuard(req.ip, email); } catch (e) { console.error('[limit]', e.message); bad(res, 503, field, UNAVAILABLE); return true; }
  if (g.blocked) { bad(res, 429, field, 'Error: demasiados intentos, probá de nuevo en unos minutos'); return true; }
  if (g.delayMs) await sleep(g.delayMs);
  return false;
}
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Error interno' }); });
const bad = (res, code, field, error) => res.status(code).json({ field, error });
const noSession = res => res.status(401).json({ error: 'Sin sesión' });
// Vercel ya lee y convierte el cuerpo JSON antes de llegar acá; si Express intentara leerlo otra vez fallaría ("stream is not readable").
app.use((req, _res, next) => { if (process.env.VERCEL && req.body && typeof req.body === 'object') req._body = true; next(); });
app.use(express.json({ limit: '200kb' }));
app.post('/api/auth/register', sharedLimiter('register', 10, 3600000, 'Demasiados registros desde esta red, probá más tarde', { failOpen: false }), wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase(), pw = String(req.body?.password || ''), name = String(req.body?.name || '').trim().slice(0, 40);
  if (!EMAIL.test(email) || email.length > 120) return bad(res, 400, 'email', 'Error: ingresá un email válido');
  if (pw.length < MIN_PW || pw.length > 200) return bad(res, 400, 'password', `Error: la contraseña debe tener al menos ${MIN_PW} caracteres`);
  const taken = () => bad(res, 409, 'email', 'Error: ya existe una cuenta con ese email');
  if (await store.getUser(email)) return taken();
  const salt = crypto.randomBytes(16).toString('hex'), hash = (await scrypt(pw, salt)).toString('hex'), user = { name: name || email.split('@')[0], salt, hash };
  if (!await store.createUser(email, user)) return taken(); // otro registro igual llegó mientras se calculaba el hash
  await startSession(req, res, email);
  res.status(201).json({ user: publicUser(email, user) });
}));
// Tope por IP ANTES de calcular scrypt (que gasta CPU): sin esto, un atacante con muchas IPs consume cómputo de la función a costa de quien la paga.
app.post('/api/auth/login', sharedLimiter('login', 30, 60000, 'Demasiados intentos, probá de nuevo en un minuto', { failOpen: false }), wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase(), pw = String(req.body?.password || '').slice(0, 200);
  if (await guarded(req, res, email, 'email')) return;
  const u = await store.getUser(email);
  const derived = await scrypt(pw, u?.salt ?? DUMMY_SALT);
  // Mismo mensaje y mismo tiempo exista o no la cuenta: el acceso no revela qué emails están registrados.
  // (El registro sí dice «ya existe una cuenta con ese email»: es un compromiso de usabilidad conocido, no se oculta.)
  if (!u || !crypto.timingSafeEqual(derived, Buffer.from(u.hash, 'hex'))) { await addFail(req.ip, email); return bad(res, 401, 'password', 'Error: email o contraseña incorrectos'); }
  await startSession(req, res, email); res.json({ user: publicUser(email, u), profile: await store.getProfile(email) });
}));
app.post('/api/auth/logout', wrap(async (req, res) => { const c = sidOf(req); if (c) await store.delSession(sha(c)); res.setHeader('Set-Cookie', cookie(req, '', 0)); res.json({ ok: true }); }));
app.get('/api/auth/me', wrap(async (req, res) => { const e = await me(req); if (!e) return noSession(res); const [u, profile] = await Promise.all([store.getUser(e), store.getProfile(e)]); res.json({ user: publicUser(e, u), profile }); }));
// ---- Perfil: se valida la forma, se limita el tamaño y se versiona (rev) para que un dispositivo no pise al otro ----
const num = v => typeof v === 'number' && Number.isFinite(v);
const strs = (a, max, len) => (Array.isArray(a) ? a : []).filter(x => typeof x === 'string').map(x => x.slice(0, len)).slice(0, max);
export function cleanProfile(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const tags = {};
  if (p.tags && typeof p.tags === 'object' && !Array.isArray(p.tags))
    for (const [k, v] of Object.entries(p.tags).slice(0, 3000)) {
      if (k.length > 120 || !Array.isArray(v)) continue;
      const ev = v.filter(e => e && num(e.w) && num(e.t)).slice(-40).map(e => ({ w: e.w, t: e.t }));
      if (ev.length) tags[k] = ev;
    }
  const items = a => (Array.isArray(a) ? a : []).filter(x => x && typeof x.id === 'string' && x.id.length <= 120).slice(-500);
  return { version: 1, onboardingDone: !!p.onboardingDone, region: typeof p.region === 'string' ? p.region.slice(0, 2).toUpperCase() : 'AR',
    tags, bands: strs(p.bands, 15, 60), favorites: items(p.favorites), blocked: strs(p.blocked, 500, 120),
    games: (Array.isArray(p.games) ? p.games : []).filter(g => g && typeof g.id === 'string' && typeof g.title === 'string').slice(0, 20)
      .map(g => ({ id: g.id.slice(0, 120), title: g.title.slice(0, 80), tags: strs(g.tags, 8, 60) })),
    adult: p.adult === true, musicApp: typeof p.musicApp === 'string' ? p.musicApp.slice(0, 12) : '' };
}
app.get('/api/profile', wrap(async (req, res) => { const e = await me(req); e ? res.json({ profile: await store.getProfile(e) }) : noSession(res); }));
// Guardar: solo si la versión que manda el cliente (base) es la vigente. La comprobación y la escritura son una sola operación
// atómica del almacenamiento (putProfileIf); antes eran pasos separados y dos pedidos simultáneos podían pasar los dos.
app.put('/api/profile', wrap(async (req, res) => {
  const e = await me(req); if (!e) return noSession(res);
  const clean = cleanProfile(req.body?.profile); if (!clean) return res.status(400).json({ error: 'Perfil inválido' });
  const base = Number(req.body?.base) || 0;
  clean.rev = base + 1;
  const r = await store.putProfileIf(e, base, clean);
  if (r.gone) return noSession(res);
  if (!r.ok) return res.status(409).json({ error: 'Tu perfil cambió en otro dispositivo', profile: r.cur }); // quien escribe con una versión vieja no pisa lo nuevo
  res.json({ ok: true, rev: clean.rev });
}));
// Borrar gustos y favoritos de verdad. Queda un perfil vacío con la versión siguiente (no se borra la clave): así un dispositivo que
// todavía tenga datos viejos choca con un 409 en vez de resucitarlos.
app.delete('/api/profile', wrap(async (req, res) => {
  const e = await me(req); if (!e) return noSession(res);
  for (let i = 0; i < 3; i++) {
    const cur = await store.getProfile(e), rev = cur?.rev || 0, empty = { ...cleanProfile({}), rev: rev + 1 };
    const r = await store.putProfileIf(e, rev, empty);
    if (r.gone) return noSession(res);
    if (r.ok) return res.json({ ok: true, profile: empty });
  }
  res.status(409).json({ error: 'Tu perfil cambió justo ahora, probá de nuevo' });
}));

// ---- Correo (recuperar contraseña): Resend por HTTP. Sin RESEND_API_KEY no se envía nada (en desarrollo el enlace sale por consola). ----
async function sendMail(to, subject, text) {
  if (!RESEND_API_KEY || !MAIL_FROM) { console.warn('[mail] Sin RESEND_API_KEY/MAIL_FROM: no se envió el correo a', to); return false; }
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: MAIL_FROM, to, subject, text }) });
  if (!r.ok) throw new Error('Resend ' + r.status); return true;
}
const baseUrl = req => (APP_URL || `${req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http'}://${req.headers.host}`).replace(/\/$/, '');
const RESET_TTL_S = 3600;
// Siempre responde lo mismo exista o no la cuenta (no se puede averiguar qué emails están registrados).
app.post('/api/auth/forgot', sharedLimiter('forgot', 5, 3600000, 'Demasiados pedidos, probá más tarde', { failOpen: false }), wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (EMAIL.test(email) && email.length <= 120 && (await store.incr(`forgot:${sha(email)}:${Math.floor(Date.now() / 36e5)}`, 3600 + 5)) <= 3) {
    const u = await store.getUser(email);
    if (u) {
      const t = crypto.randomBytes(32).toString('hex'); await store.putToken('reset', sha(t), { email }, RESET_TTL_S);
      const link = `${baseUrl(req)}/#/reset/${t}`;
      if (!await sendMail(email, 'Recuperá tu contraseña de Pulso', `Hola ${u.name}:\n\nPara elegir una contraseña nueva abrí este enlace (vale 1 hora y se usa una sola vez):\n${link}\n\nSi no lo pediste vos, ignorá este mensaje: tu contraseña no cambia.`) && NODE_ENV !== 'production') console.log('[mail] enlace de recuperación (solo desarrollo):', link);
    }
  }
  res.json({ ok: true });
}));
app.post('/api/auth/reset', sharedLimiter('reset', 10, 3600000, 'Demasiados intentos, probá más tarde', { failOpen: false }), wrap(async (req, res) => {
  const pw = String(req.body?.password || ''), t = String(req.body?.token || '');
  if (pw.length < MIN_PW || pw.length > 200) return bad(res, 400, 'password', `Error: la contraseña debe tener al menos ${MIN_PW} caracteres`);
  const tok = /^[a-f0-9]{64}$/.test(t) ? await store.takeToken('reset', sha(t)) : null; // takeToken lo borra: el enlace sirve una sola vez
  const u = tok && await store.getUser(tok.email);
  if (!u) return bad(res, 400, 'password', 'Error: el enlace no es válido o ya venció. Pedí uno nuevo');
  const salt = crypto.randomBytes(16).toString('hex'), hash = (await scrypt(pw, salt)).toString('hex');
  await store.setPassword(tok.email, salt, hash);
  await store.delUserSessions(tok.email); // si alguien más tenía la sesión abierta, se cierra
  await startSession(req, res, tok.email); res.json({ user: publicUser(tok.email, u), profile: await store.getProfile(tok.email) });
}));
// Cerrar sesión en todos los dispositivos
app.post('/api/auth/logout-all', wrap(async (req, res) => { const e = await me(req); if (!e) return noSession(res); await store.delUserSessions(e); res.setHeader('Set-Cookie', cookie(req, '', 0)); res.json({ ok: true }); }));
// Borrado real de la cuenta: email, nombre, contraseña, perfil y sesiones. Pide la contraseña para confirmar.
app.delete('/api/auth/account', wrap(async (req, res) => {
  const e = await me(req); if (!e) return noSession(res);
  if (await guarded(req, res, e, 'password')) return;
  const u = await store.getUser(e), pw = String(req.body?.password || '').slice(0, 200), derived = await scrypt(pw, u.salt);
  if (!crypto.timingSafeEqual(derived, Buffer.from(u.hash, 'hex'))) { await addFail(req.ip, e); return bad(res, 401, 'password', 'Error: contraseña incorrecta'); }
  await store.deleteUser(e); res.setHeader('Set-Cookie', cookie(req, '', 0)); res.json({ ok: true });
}));
app.get('/api/health', (_q, res) => res.json({ ok: true })); // sin datos internos: uptime, caché y tipo de almacenamiento no se publican

registerPersonal({ route, cached, j, strip, chartSongs, song, movieFrom, show, gameFrom, tagText, hdr, enrich, H, D });

app.use('/api', (_q, res) => res.status(404).json({ error: 'No existe' }));
app.use(express.static(path.join(import.meta.dirname, '../public'), { maxAge: NODE_ENV === 'production' ? '1h' : 0 }));
// JSON inválido o demasiado grande -> respuesta limpia en vez de una página de error con rastro de pila
app.use((err, _q, res, _n) => { const code = err.status && err.status < 500 ? err.status : 500; if (code === 500) console.error(err); res.status(code).json({ error: code === 413 ? 'Datos demasiado grandes' : code === 500 ? 'Error interno' : 'Petición inválida' }); });
// En Vercel la app corre como función (el server.js de la raíz importa `app`); en cualquier otro lado, como servidor normal.
if (!process.env.VERCEL) {
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0)); // 'exit' guarda lo pendiente
  const server = app.listen(PORT, () => console.log('Pulso en http://localhost:' + PORT));
  server.requestTimeout = 30000; server.headersTimeout = 15000; // conexiones lentas no acaparan el servidor
}
export { strip };
export default app;
